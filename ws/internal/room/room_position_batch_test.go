package room

import (
	"context"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/monitoring"

	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type batchPositionStore struct {
	positionStore
	batch func(context.Context, []string) (map[string]redisroom.Position, error)
}

type liveBatchStore struct {
	frameRoomStore
	started chan struct{}
	release chan struct{}
}

func (store *liveBatchStore) TailBatch(_ context.Context, names []string) (map[string]redisroom.Position, error) {
	close(store.started)
	<-store.release
	positions := make(map[string]redisroom.Position, len(names))
	for _, name := range names {
		positions[name] = redisroom.Position{Epoch: "stale-epoch", StreamID: "1-0"}
	}
	return positions, nil
}

func TestStaleBatchCannotRecoverAContinuouslyAdvancingRoom(t *testing.T) {
	feed := &restartFeed{results: make(chan feedResult, 1)}
	store := &liveBatchStore{frameRoomStore: frameRoomStore{feed: feed}, started: make(chan struct{}), release: make(chan struct{})}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &frameSink{frames: make(chan *protocol.EventFrame, 8)}
	if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	waitFrame(t, sink.frames)
	checked := make(chan struct{})
	go func() { rooms.checkAll(context.Background()); close(checked) }()
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("position batch did not start")
	}
	feed.results <- feedResult{live: positionLive("2-0", "1-0")}
	if frame := waitFrame(t, sink.frames); frame.Event().StreamID != "2-0" {
		t.Fatalf("live event = %+v", frame.Event())
	}
	close(store.release)
	select {
	case <-checked:
	case <-time.After(time.Second):
		t.Fatal("position batch did not finish")
	}
	select {
	case frame := <-sink.frames:
		t.Fatalf("stale batch emitted %+v", frame.Event())
	default:
	}
}

func (store *batchPositionStore) TailBatch(ctx context.Context, names []string) (map[string]redisroom.Position, error) {
	return store.batch(ctx, names)
}

func TestQuietRoomBatchesPreservePartialRecovery(t *testing.T) {
	var batches atomic.Int32
	store := &batchPositionStore{positionStore: positionStore{
		tail: func(context.Context, string) (string, string, error) { return "epoch", "1-0", nil },
		replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
			return []redisroom.Live{positionLive("2-0", "1-0")}, nil
		},
	}}
	store.batch = func(_ context.Context, names []string) (map[string]redisroom.Position, error) {
		batches.Add(1)
		if len(names) > 128 {
			t.Errorf("position batch contains %d rooms", len(names))
		}
		result := make(map[string]redisroom.Position, len(names))
		for _, name := range names {
			if name == "group:recent" {
				t.Error("recent live room was checked")
			}
			position := redisroom.Position{Epoch: "epoch", StreamID: "1-0"}
			if name == "group:failed" {
				position.Err = errors.New("tail unavailable")
			}
			if name == "group:lagging" {
				position.StreamID = "2-0"
			}
			result[name] = position
		}
		return result, nil
	}
	rooms := newPositionRooms(&store.positionStore)
	rooms.redis = store
	rooms.checkInterval = time.Minute
	for i := range 128 {
		addPositionRoom(rooms, fmt.Sprintf("group:quiet-%d", i), &positionSink{})
	}
	failed, lagging := &positionSink{}, &positionSink{}
	addPositionRoom(rooms, "group:failed", failed)
	addPositionRoom(rooms, "group:lagging", lagging)
	addPositionRoom(rooms, "group:recent", &positionSink{})
	rooms.rooms["group:recent"].lastLiveAt = time.Now()
	rooms.checkAll(context.Background())
	if batches.Load() != 2 {
		t.Fatalf("position batches = %d, want 2", batches.Load())
	}
	if len(failed.events) != 1 || failed.events[0].Type != protocol.EventRecoveryFailed {
		t.Fatalf("failed room events = %+v", failed.events)
	}
	if len(lagging.events) != 1 || lagging.events[0].EventID != "2-0" {
		t.Fatalf("lagging room events = %+v", lagging.events)
	}
}
