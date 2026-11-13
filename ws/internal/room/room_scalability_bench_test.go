package room

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type benchmarkFrameSink struct{ frames int }

func (sink *benchmarkFrameSink) Enqueue(protocol.Event) bool            { sink.frames++; return true }
func (sink *benchmarkFrameSink) EnqueueFrame(*protocol.EventFrame) bool { sink.frames++; return true }

func BenchmarkSharedFrameFanout(b *testing.B) {
	for _, recipients := range []int{1, 100, 1000, 10000} {
		b.Run(fmt.Sprintf("recipients=%d", recipients), func(b *testing.B) {
			rooms := newPositionRooms(&positionStore{})
			entry := &localRoom{name: "group:chat", epoch: "epoch", members: make(map[Recipient]*roomMember)}
			rooms.rooms[entry.name] = entry
			for range recipients {
				member := newRoomMember()
				member.chatIDs["chat"] = true
				member.finishCatchup()
				entry.members[&benchmarkFrameSink{}] = member
			}
			event := protocol.Event{Type: protocol.EventMessageSaved, Version: 1, Room: entry.name, ChatID: "chat", Epoch: "epoch", Body: "group message"}
			sequence := uint64(0)
			b.ReportAllocs()
			for b.Loop() {
				sequence++
				event.StreamID = strconv.FormatUint(sequence, 10) + "-0"
				rooms.dispatch(entry.name, event)
			}
			b.ReportMetric(float64(recipients), "recipients/event")
		})
	}
}

type benchmarkRoomStore struct{}

func (benchmarkRoomStore) Subscribe(context.Context, string) (roomFeed, error) {
	return &controlledRoomFeed{}, nil
}
func (benchmarkRoomStore) Tail(context.Context, string) (string, string, error) {
	return "epoch", "1-0", nil
}
func (benchmarkRoomStore) Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
	return nil, nil
}

func BenchmarkLeaveAllWithUnrelatedRooms(b *testing.B) {
	for _, count := range []int{1000, 10000} {
		b.Run(fmt.Sprintf("rooms=%d", count), func(b *testing.B) {
			rooms := newRooms(benchmarkRoomStore{}, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Minute, monitoring.New(prometheus.NewRegistry()))
			b.Cleanup(rooms.Close)
			ctx := context.Background()
			for i := range count {
				if err := rooms.Join(ctx, &benchmarkFrameSink{}, fmt.Sprintf("user:%d", i), "", "", ""); err != nil {
					b.Fatal(err)
				}
			}
			target := &benchmarkFrameSink{}
			b.ReportAllocs()
			b.ResetTimer()
			for i := 0; i < b.N; i++ {
				b.StopTimer()
				if err := rooms.Join(ctx, target, "user:0", "", "", ""); err != nil {
					b.Fatal(err)
				}
				b.StartTimer()
				rooms.LeaveAll(target)
			}
		})
	}
}

func BenchmarkBatchedQuietPositionSweep(b *testing.B) {
	for _, count := range []int{1000, 10000} {
		b.Run(fmt.Sprintf("rooms=%d", count), func(b *testing.B) {
			store := &batchPositionStore{}
			store.batch = func(_ context.Context, names []string) (map[string]redisroom.Position, error) {
				positions := make(map[string]redisroom.Position, len(names))
				for _, name := range names {
					positions[name] = redisroom.Position{Epoch: "epoch", StreamID: "1-0"}
				}
				return positions, nil
			}
			rooms := newPositionRooms(&store.positionStore)
			rooms.redis = store
			for i := range count {
				addPositionRoom(rooms, fmt.Sprintf("user:%d", i), &positionSink{})
			}
			b.ReportAllocs()
			for b.Loop() {
				rooms.checkAll(context.Background())
			}
		})
	}
}
