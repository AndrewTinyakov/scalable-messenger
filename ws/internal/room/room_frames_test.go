package room

import (
	"context"
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

type frameRoomStore struct{ feed *restartFeed }

func (store *frameRoomStore) Subscribe(context.Context, string) (roomFeed, error) {
	return store.feed, nil
}

type bufferedFrameStore struct {
	frameRoomStore
	started chan struct{}
	release chan struct{}
	replays atomic.Int32
}

func (store *bufferedFrameStore) Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
	if store.replays.Add(1) == 2 {
		close(store.started)
		<-store.release
	}
	return nil, nil
}

func TestReplayBufferRetainsSharedLiveFrame(t *testing.T) {
	feed := &restartFeed{results: make(chan feedResult, 1)}
	store := &bufferedFrameStore{frameRoomStore: frameRoomStore{feed: feed}, started: make(chan struct{}), release: make(chan struct{})}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	first, second := &frameSink{frames: make(chan *protocol.EventFrame, 8)}, &frameSink{frames: make(chan *protocol.EventFrame, 8)}
	if err := rooms.Join(context.Background(), first, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	waitFrame(t, first.frames)
	joined := make(chan error, 1)
	go func() { joined <- rooms.Join(context.Background(), second, "group:chat", "chat", "epoch", "1-0") }()
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("second replay did not start")
	}
	feed.results <- feedResult{live: positionLive("2-0", "1-0")}
	firstFrame := waitFrame(t, first.frames)
	close(store.release)
	select {
	case err := <-joined:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("second replay did not finish")
	}
	if buffered := waitFrame(t, second.frames); buffered != firstFrame {
		t.Fatal("replay buffer re-encoded the shared live event")
	}
	if subscribed := waitFrame(t, second.frames); subscribed.Event().Type != protocol.EventSubscribed {
		t.Fatalf("buffered live event was not followed by subscribed: %+v", subscribed.Event())
	}
}
func (*frameRoomStore) Tail(context.Context, string) (string, string, error) {
	return "epoch", "1-0", nil
}
func (*frameRoomStore) Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
	return nil, nil
}

type frameSink struct{ frames chan *protocol.EventFrame }

func (sink *frameSink) Enqueue(event protocol.Event) bool {
	frame, err := protocol.NewEventFrame(event)
	return err == nil && sink.EnqueueFrame(frame)
}

func (sink *frameSink) EnqueueFrame(frame *protocol.EventFrame) bool {
	sink.frames <- frame
	return true
}

func TestJoinedRecipientsShareEncodedLiveFrame(t *testing.T) {
	feed := &restartFeed{results: make(chan feedResult, 1)}
	store := &frameRoomStore{feed: feed}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	first, second := &frameSink{frames: make(chan *protocol.EventFrame, 8)}, &frameSink{frames: make(chan *protocol.EventFrame, 8)}
	for _, sink := range []*frameSink{first, second} {
		if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
			t.Fatal(err)
		}
		if frame := waitFrame(t, sink.frames); frame.Event().Type != protocol.EventSubscribed {
			t.Fatalf("first frame = %+v", frame.Event())
		}
	}
	feed.results <- feedResult{live: positionLive("2-0", "1-0")}
	firstFrame, secondFrame := waitFrame(t, first.frames), waitFrame(t, second.frames)
	if firstFrame != secondFrame {
		t.Fatal("room fanout encoded separate frames for its recipients")
	}
	if event := firstFrame.Event(); event.Version != 1 || event.Epoch != "epoch" || event.StreamID != "2-0" {
		t.Fatalf("live frame = %+v", event)
	}
}

func waitFrame(t *testing.T, frames <-chan *protocol.EventFrame) *protocol.EventFrame {
	t.Helper()
	select {
	case frame := <-frames:
		return frame
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for frame")
		return nil
	}
}
