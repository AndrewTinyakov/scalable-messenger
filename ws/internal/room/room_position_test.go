package room

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type positionStore struct {
	tail   func(context.Context, string) (string, string, error)
	replay func(context.Context, string, string, string, int64) ([]redisroom.Live, error)
}

func (*positionStore) Subscribe(context.Context, string) (roomFeed, error) {
	return nil, errors.New("unused")
}
func (store *positionStore) Tail(ctx context.Context, room string) (string, string, error) {
	return store.tail(ctx, room)
}
func (store *positionStore) Replay(ctx context.Context, room, epoch, after string, limit int64) ([]redisroom.Live, error) {
	return store.replay(ctx, room, epoch, after, limit)
}

type positionSink struct {
	mu     sync.Mutex
	events []protocol.Event
}

func (sink *positionSink) Enqueue(event protocol.Event) bool {
	sink.mu.Lock()
	sink.events = append(sink.events, event)
	sink.mu.Unlock()
	return true
}

func newPositionRooms(store *positionStore) *Rooms {
	return &Rooms{rooms: make(map[string]*localRoom), redis: store, replayLimit: 8, bufferLimit: 8, bufferBytes: 4096, metrics: monitoring.New(prometheus.NewRegistry()), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func addPositionRoom(rooms *Rooms, name string, sink *positionSink) {
	ready := make(chan struct{})
	close(ready)
	member := newRoomMember()
	member.finishCatchup()
	member.chatIDs["chat"] = true
	rooms.rooms[name] = &localRoom{name: name, ready: ready, epoch: "epoch", lastID: "1-0", members: map[Recipient]*roomMember{sink: member}}
}

func positionLive(id, previous string) redisroom.Live {
	return redisroom.Live{
		Epoch: "epoch", StreamID: id, PreviousStreamID: previous, HasPrevious: true,
		Event: protocol.Event{Type: "message_saved", EventID: id, Epoch: "epoch", StreamID: id, Room: "group:chat", ChatID: "chat"},
	}
}

func TestLiveGapReplaysMissedIntermediateEvent(t *testing.T) {
	store := &positionStore{}
	store.replay = func(_ context.Context, _, _, after string, _ int64) ([]redisroom.Live, error) {
		if after != "1-0" {
			t.Fatalf("replay after = %q, want 1-0", after)
		}
		return []redisroom.Live{positionLive("2-0", "1-0"), positionLive("3-0", "2-0")}, nil
	}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.handleLive(context.Background(), "group:chat", positionLive("3-0", "2-0"))
	if len(sink.events) != 2 || sink.events[0].EventID != "2-0" || sink.events[1].EventID != "3-0" {
		t.Fatalf("events = %+v, want missed then current", sink.events)
	}
	rooms.handleLive(context.Background(), "group:chat", positionLive("2-0", "1-0"))
	if len(sink.events) != 2 {
		t.Fatalf("duplicate live event delivered: %+v", sink.events)
	}
}

func TestLiveGapWithoutRetainedHistoryRequestsSQLRecovery(t *testing.T) {
	store := &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
		return nil, redisroom.ErrGap
	}}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.handleLive(context.Background(), "group:chat", positionLive("3-0", "2-0"))
	if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
		t.Fatalf("events = %+v, want SQL recovery", sink.events)
	}
}

func TestPositionChecksBoundConcurrentRedisReads(t *testing.T) {
	entered := make(chan struct{}, 32)
	release := make(chan struct{})
	store := &positionStore{tail: func(ctx context.Context, _ string) (string, string, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return "epoch", "1-0", nil
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
	}}
	rooms := newPositionRooms(store)
	for i := range 32 {
		addPositionRoom(rooms, "group:"+string(rune('a'+i)), &positionSink{})
	}
	done := make(chan struct{})
	go func() { rooms.checkAll(context.Background()); close(done) }()
	for range 16 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("did not start 16 bounded checks")
		}
	}
	select {
	case <-entered:
		t.Fatal("started more than 16 checks")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("position checks did not finish")
	}
}

func TestPositionCheckSkipsRoomWithRecentLiveEvent(t *testing.T) {
	reads := 0
	store := &positionStore{tail: func(context.Context, string) (string, string, error) {
		reads++
		return "epoch", "1-0", nil
	}}
	rooms := newPositionRooms(store)
	rooms.checkInterval = time.Minute
	addPositionRoom(rooms, "group:chat", &positionSink{})
	rooms.rooms["group:chat"].lastLiveAt = time.Now()
	rooms.checkAll(context.Background())
	if reads != 0 {
		t.Fatalf("Redis tail reads = %d, want 0 for a room with recent live traffic", reads)
	}
}

func TestPositionCheckReplaysMissedFinalEvent(t *testing.T) {
	store := &positionStore{
		tail: func(context.Context, string) (string, string, error) {
			return "epoch", "2-0", nil
		},
		replay: func(_ context.Context, _, _, after string, _ int64) ([]redisroom.Live, error) {
			if after != "1-0" {
				t.Fatalf("replay after = %q, want 1-0", after)
			}
			return []redisroom.Live{positionLive("2-0", "1-0")}, nil
		},
	}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.checkAll(context.Background())
	if len(sink.events) != 1 || sink.events[0].EventID != "2-0" {
		t.Fatalf("events = %+v, want missed final event", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "2-0" {
		t.Fatalf("room position = %q, want 2-0", last)
	}
}

func TestPositionCheckWithoutRetainedHistoryRequestsSQLRecovery(t *testing.T) {
	store := &positionStore{
		tail: func(context.Context, string) (string, string, error) {
			return "epoch", "2-0", nil
		},
		replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
			return nil, redisroom.ErrGap
		},
	}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.checkAll(context.Background())
	if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
		t.Fatalf("events = %+v, want SQL recovery request", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "2-0" {
		t.Fatalf("room position = %q, want 2-0", last)
	}
}

func TestRestoredGroupFeedReplaysMessagesPublishedDuringOutage(t *testing.T) {
	store := &positionStore{replay: func(_ context.Context, _, _, after string, _ int64) ([]redisroom.Live, error) {
		if after != "1-0" {
			t.Fatalf("replay after = %q, want 1-0", after)
		}
		return []redisroom.Live{positionLive("2-0", "1-0"), positionLive("3-0", "2-0")}, nil
	}}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.reconcileAfterResubscribe(context.Background(), rooms.rooms["group:chat"], "epoch", "3-0")
	if len(sink.events) != 2 || sink.events[0].EventID != "2-0" || sink.events[1].EventID != "3-0" {
		t.Fatalf("events after feed restoration = %+v, want the complete gap", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "3-0" {
		t.Fatalf("room position = %q, want 3-0", last)
	}
}

func TestRestoredGroupFeedRequestsFreshSQLRecoveryWhenReplayFails(t *testing.T) {
	store := &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
		return nil, redisroom.ErrGap
	}}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.reconcileAfterResubscribe(context.Background(), rooms.rooms["group:chat"], "epoch", "3-0")
	if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
		t.Fatalf("events after feed restoration = %+v, want a new SQL recovery signal", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "3-0" {
		t.Fatalf("room position = %q, want 3-0", last)
	}
}

func TestEpochChangeRequestsSQLRecovery(t *testing.T) {
	for _, test := range []struct {
		name          string
		advance       func(*Rooms)
		wantLiveEvent bool
	}{
		{
			name: "live event",
			advance: func(rooms *Rooms) {
				live := positionLive("1-0", "")
				live.Epoch = "new-epoch"
				live.Event.Epoch = live.Epoch
				rooms.handleLive(context.Background(), "group:chat", live)
			},
			wantLiveEvent: true,
		},
		{
			name:    "quiet position check",
			advance: func(rooms *Rooms) { rooms.checkAll(context.Background()) },
		},
		{
			name: "restored feed",
			advance: func(rooms *Rooms) {
				rooms.reconcileAfterResubscribe(context.Background(), rooms.rooms["group:chat"], "new-epoch", "1-0")
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &positionStore{
				tail: func(context.Context, string) (string, string, error) {
					return "new-epoch", "1-0", nil
				},
				replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
					t.Fatal("an epoch change cannot use Redis replay")
					return nil, nil
				},
			}
			registry := prometheus.NewRegistry()
			rooms := newPositionRooms(store)
			rooms.metrics = monitoring.New(registry)
			sink := &positionSink{}
			addPositionRoom(rooms, "group:chat", sink)
			test.advance(rooms)
			if len(sink.events) == 0 || sink.events[0].Type != "recovery_failed" {
				t.Fatalf("events = %+v, want SQL recovery", sink.events)
			}
			assertStaleRooms(t, registry, monitoring.RoomEpochChanged)
			if test.wantLiveEvent {
				if len(sink.events) != 2 || sink.events[1].EventID != "1-0" {
					t.Fatalf("events = %+v, want the new live event after SQL recovery", sink.events)
				}
			} else if len(sink.events) != 1 {
				t.Fatalf("events = %+v, want only SQL recovery", sink.events)
			}
			if _, epoch, last := rooms.roomPosition("group:chat"); epoch != "new-epoch" || last != "1-0" {
				t.Fatalf("room position = (%q, %q), want (new-epoch, 1-0)", epoch, last)
			}
		})
	}
}

func TestPositionChecksPauseAfterSlowSweep(t *testing.T) {
	const interval = 100 * time.Millisecond
	entered := make(chan int, 2)
	release := make(chan struct{})
	calls := 0
	store := &positionStore{tail: func(ctx context.Context, _ string) (string, string, error) {
		calls++
		entered <- calls
		if calls == 1 {
			select {
			case <-release:
			case <-ctx.Done():
				return "", "", ctx.Err()
			}
		}
		return "epoch", "1-0", nil
	}}
	rooms := newPositionRooms(store)
	rooms.checkInterval = interval
	addPositionRoom(rooms, "user:quiet", &positionSink{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { rooms.RunChecks(ctx); close(done) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first sweep did not start")
	}
	time.Sleep(2 * interval)
	close(release)
	select {
	case <-entered:
		t.Fatal("second sweep started immediately after an overlong sweep")
	case <-time.After(interval / 3):
	}
	select {
	case <-entered:
	case <-time.After(2 * interval):
		t.Fatal("second sweep did not start after the interval")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("position checker did not stop")
	}
}

func TestContinuityReplayMetricsSeparateRoomWorkFromRecipientQueues(t *testing.T) {
	items := []redisroom.Live{positionLive("2-0", "1-0"), positionLive("3-0", "2-0")}
	store := &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) { return items, nil }}
	rooms := newPositionRooms(store)
	first, second := &positionSink{}, &positionSink{}
	addPositionRoom(rooms, "group:chat", first)
	member := newRoomMember()
	member.finishCatchup()
	rooms.rooms["group:chat"].members[second] = member
	rooms.handleLive(context.Background(), "group:chat", positionLive("3-0", "2-0"))
	if len(first.events) != 2 || len(second.events) != 2 {
		t.Fatalf("events = %d and %d, want 2 per recipient", len(first.events), len(second.events))
	}
	if got := replayCounterValue(t, rooms.metrics.ContinuityReplayEvents); got != 2 {
		t.Fatalf("room replay events = %v, want 2", got)
	}
	bytes := 0
	for _, item := range items {
		frame, err := protocol.NewEventFrame(item.Event)
		if err != nil {
			t.Fatal(err)
		}
		bytes += frame.Size()
	}
	if got := replayCounterValue(t, rooms.metrics.ContinuityReplayBytes); got != float64(bytes) {
		t.Fatalf("room replay bytes = %v, want %d", got, bytes)
	}
	if got := replayCounterValue(t, rooms.metrics.ReplayEvents); got != 0 {
		t.Fatalf("subscribe events = %v, want 0", got)
	}
}

func TestContinuityReplayMetricsRecordFailuresWithoutDispatch(t *testing.T) {
	for _, test := range []struct {
		name    string
		items   []redisroom.Live
		err     error
		outcome string
	}{
		{name: "retention gap or replay cap", err: redisroom.ErrGap, outcome: "gap"},
		{name: "required position absent", items: []redisroom.Live{positionLive("2-0", "1-0")}, outcome: "gap"},
		{name: "cancelled", err: context.Canceled, outcome: "cancelled"},
		{name: "deadline", err: context.DeadlineExceeded, outcome: "cancelled"},
		{name: "dependency or payload", err: errors.New("private error"), outcome: "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			store := &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
				return test.items, test.err
			}}
			rooms := newPositionRooms(store)
			sink := &positionSink{}
			addPositionRoom(rooms, "group:chat", sink)
			if rooms.replayRoomThrough(context.Background(), rooms.rooms["group:chat"], "epoch", "1-0", "3-0") == nil {
				t.Fatal("incomplete replay succeeded")
			}
			if len(sink.events) != 0 || replayCounterValue(t, rooms.metrics.ContinuityReplayEvents) != 0 {
				t.Fatal("failed replay dispatched or counted events")
			}
			registry := prometheus.NewRegistry()
			registry.MustRegister(rooms.metrics.ReplaySeconds)
			families, err := registry.Gather()
			if err != nil {
				t.Fatal(err)
			}
			observed := families[0].Metric
			if len(observed) != 1 || observed[0].GetHistogram().GetSampleCount() != 1 {
				t.Fatalf("observations = %v, want exactly one", observed)
			}
			labels := map[string]string{}
			for _, label := range observed[0].Label {
				labels[label.GetName()] = label.GetValue()
			}
			if len(labels) != 2 || labels["trigger"] != "continuity" || labels["result"] != test.outcome {
				t.Fatalf("labels = %v", labels)
			}
		})
	}
}

func replayCounterValue(t *testing.T, counter prometheus.Counter) float64 {
	t.Helper()
	metric := &dto.Metric{}
	if err := counter.Write(metric); err != nil {
		t.Fatal(err)
	}
	return metric.GetCounter().GetValue()
}
