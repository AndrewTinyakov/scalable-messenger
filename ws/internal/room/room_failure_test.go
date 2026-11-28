package room

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/redisroom"
)

func TestStaleRoomsAreCountedByReason(t *testing.T) {
	for _, test := range []struct {
		name   string
		store  *positionStore
		act    func(*Rooms)
		reason monitoring.RoomFailureReason
	}{
		{
			name: "position read failed",
			store: &positionStore{tail: func(context.Context, string) (string, string, error) {
				return "", "", errors.New("redis timeout")
			}},
			act:    func(rooms *Rooms) { rooms.checkAll(context.Background()) },
			reason: monitoring.RoomPositionReadFailed,
		},
		{
			name: "gap replay cannot repair",
			store: &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
				return nil, redisroom.ErrGap
			}},
			act:    reconcileTo("epoch", "3-0"),
			reason: monitoring.RoomUnrepairedGap,
		},
		{
			name: "replay failed",
			store: &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
				return nil, errors.New("redis timeout")
			}},
			act:    reconcileTo("epoch", "3-0"),
			reason: monitoring.RoomReplayFailed,
		},
		{
			name:   "epoch changed",
			store:  &positionStore{},
			act:    reconcileTo("new-epoch", "1-0"),
			reason: monitoring.RoomEpochChanged,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			registry := prometheus.NewRegistry()
			rooms := newPositionRooms(test.store)
			rooms.checkInterval = time.Hour
			rooms.metrics = monitoring.New(registry)
			sink := &positionSink{}
			addPositionRoom(rooms, "group:chat", sink)
			test.act(rooms)
			if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
				t.Fatalf("events = %+v, want SQL recovery", sink.events)
			}
			counts := staleRoomCounts(t, registry)
			for _, reason := range monitoring.RoomFailureReasons {
				want := 0.0
				if reason == test.reason {
					want = 1
				}
				if counts[string(reason)] != want {
					t.Fatalf("stale rooms %s = %v, want %v (all %v)", reason, counts[string(reason)], want, counts)
				}
			}
		})
	}
}

func TestStaleRoomLogAllowsOneLinePerReasonPerInterval(t *testing.T) {
	var limiter staleRoomLogLimiter
	start := time.Unix(1000, 0)
	if allowed, suppressed := limiter.allow(monitoring.RoomFeedStopped, start); !allowed || suppressed != 0 {
		t.Fatalf("first = %v/%d, want allowed with none suppressed", allowed, suppressed)
	}
	for range 3 {
		if allowed, _ := limiter.allow(monitoring.RoomFeedStopped, start.Add(time.Second)); allowed {
			t.Fatal("repeat within the interval was allowed")
		}
	}
	if allowed, _ := limiter.allow(monitoring.RoomPositionReadFailed, start.Add(time.Second)); !allowed {
		t.Fatal("a different reason was suppressed")
	}
	allowed, suppressed := limiter.allow(monitoring.RoomFeedStopped, start.Add(staleRoomLogInterval))
	if !allowed || suppressed != 3 {
		t.Fatalf("after interval = %v/%d, want allowed with 3 suppressed", allowed, suppressed)
	}
}

func reconcileTo(epoch, last string) func(*Rooms) {
	return func(rooms *Rooms) {
		rooms.reconcileRoomPosition(context.Background(), rooms.rooms["group:chat"], "epoch", "1-0", epoch, last)
	}
}

func staleRoomCounts(t *testing.T, registry *prometheus.Registry) map[string]float64 {
	t.Helper()
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	counts := map[string]float64{}
	for _, family := range families {
		if family.GetName() != "messenger_ws_stale_rooms_total" {
			continue
		}
		for _, metric := range family.Metric {
			for _, label := range metric.Label {
				if label.GetName() == "reason" {
					counts[label.GetValue()] = metric.GetCounter().GetValue()
				}
			}
		}
	}
	return counts
}
