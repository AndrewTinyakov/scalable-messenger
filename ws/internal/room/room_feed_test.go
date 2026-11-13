package room

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"reflect"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type controlledRoomFeed struct{}

func (*controlledRoomFeed) Receive(ctx context.Context) (redisroom.Live, error) {
	<-ctx.Done()
	return redisroom.Live{}, ctx.Err()
}

func (*controlledRoomFeed) Close() error { return nil }

type feedResult struct {
	live redisroom.Live
	err  error
}

type restartFeed struct{ results chan feedResult }

func (feed *restartFeed) Receive(ctx context.Context) (redisroom.Live, error) {
	select {
	case result := <-feed.results:
		return result.live, result.err
	case <-ctx.Done():
		return redisroom.Live{}, ctx.Err()
	}
}

func (*restartFeed) Close() error { return nil }

type restartStore struct {
	mu             sync.Mutex
	feeds          []roomFeed
	subscribeCalls int
	replayCalls    int
	replayErr      error
}

func (store *restartStore) Subscribe(context.Context, string) (roomFeed, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.subscribeCalls >= len(store.feeds) {
		return nil, errors.New("unexpected Room feed subscription")
	}
	feed := store.feeds[store.subscribeCalls]
	store.subscribeCalls++
	return feed, nil
}

func (store *restartStore) Tail(context.Context, string) (string, string, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.subscribeCalls == 1 {
		return "epoch", "1-0", nil
	}
	return "epoch", "3-0", nil
}

func (store *restartStore) Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
	store.mu.Lock()
	defer store.mu.Unlock()
	store.replayCalls++
	if store.replayCalls == 1 {
		return nil, nil
	}
	if store.replayErr != nil {
		return nil, store.replayErr
	}
	return []redisroom.Live{
		{Epoch: "epoch", StreamID: "2-0", Event: protocol.Event{Type: protocol.EventMessageSaved, EventID: "event-2", ChatID: "chat", Epoch: "epoch", StreamID: "2-0"}},
		{Epoch: "epoch", StreamID: "3-0", Event: protocol.Event{Type: protocol.EventMessageSaved, EventID: "event-3", ChatID: "chat", Epoch: "epoch", StreamID: "3-0"}},
	}, nil
}

type eventSink struct{ events chan protocol.Event }

func (sink *eventSink) Enqueue(event protocol.Event) bool {
	sink.events <- event
	return true
}

type controlledRoomStore struct {
	mu    sync.Mutex
	calls []string
	feed  *controlledRoomFeed
}

func (store *controlledRoomStore) record(call string) {
	store.mu.Lock()
	store.calls = append(store.calls, call)
	store.mu.Unlock()
}

func (store *controlledRoomStore) Subscribe(context.Context, string) (roomFeed, error) {
	store.record("subscribe")
	return store.feed, nil
}

func (store *controlledRoomStore) Tail(context.Context, string) (string, string, error) {
	store.record("tail")
	return "epoch", "2-0", nil
}

func (store *controlledRoomStore) Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
	store.record("replay")
	return []redisroom.Live{{Event: protocol.Event{Type: protocol.EventMessageSaved, Version: 1, ChatID: "chat", EventID: "event-2", Epoch: "epoch", StreamID: "2-0"}}}, nil
}

func TestJoinRunsRoomFeedBeforeReplay(t *testing.T) {
	store := &controlledRoomStore{feed: &controlledRoomFeed{}}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &positionSink{}
	if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	if got := replayCounterValue(t, rooms.metrics.ReplayEvents); got != 1 {
		t.Fatalf("subscribe replay events = %v, want 1", got)
	}
	if got := replayCounterValue(t, rooms.metrics.ContinuityReplayEvents); got != 0 {
		t.Fatalf("continuity events = %v, want 0", got)
	}
	store.mu.Lock()
	calls := append([]string(nil), store.calls...)
	store.mu.Unlock()
	if want := []string{"subscribe", "tail", "replay"}; !reflect.DeepEqual(calls, want) {
		t.Fatalf("feed calls = %v, want %v", calls, want)
	}
	sink.mu.Lock()
	events := append([]protocol.Event(nil), sink.events...)
	sink.mu.Unlock()
	if len(events) != 2 || events[0].EventID != "event-2" || events[1].Type != protocol.EventSubscribed {
		t.Fatalf("events = %+v, want replay then subscribed", events)
	}
}

func TestJoinRecoversMissedEventsAfterRoomFeedRestart(t *testing.T) {
	first := &restartFeed{results: make(chan feedResult, 1)}
	second := &restartFeed{results: make(chan feedResult)}
	store := &restartStore{feeds: []roomFeed{first, second}}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &eventSink{events: make(chan protocol.Event, 8)}
	if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	if event := waitRoomEvent(t, sink.events); event.Type != protocol.EventSubscribed {
		t.Fatalf("first event = %q, want subscribed", event.Type)
	}
	first.results <- feedResult{err: errors.New("feed disconnected")}
	if event := waitRoomEvent(t, sink.events); event.Type != protocol.EventRecoveryFailed {
		t.Fatalf("outage event = %q, want recovery_failed", event.Type)
	}
	for _, want := range []string{"event-2", "event-3"} {
		if event := waitRoomEvent(t, sink.events); event.EventID != want {
			t.Fatalf("replayed event = %q, want %q", event.EventID, want)
		}
	}
}

func TestJoinRecoversLiveGapThroughRoomFeed(t *testing.T) {
	feed := &restartFeed{results: make(chan feedResult, 1)}
	store := &restartStore{feeds: []roomFeed{feed}}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &eventSink{events: make(chan protocol.Event, 8)}
	if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	if event := waitRoomEvent(t, sink.events); event.Type != protocol.EventSubscribed {
		t.Fatalf("first event = %q, want subscribed", event.Type)
	}
	feed.results <- feedResult{live: positionLive("3-0", "2-0")}
	for _, want := range []string{"event-2", "event-3"} {
		if event := waitRoomEvent(t, sink.events); event.EventID != want {
			t.Fatalf("replayed event = %q, want %q", event.EventID, want)
		}
	}
}

func TestJoinRequestsSQLRecoveryWhenRestartHasNoRetainedHistory(t *testing.T) {
	first := &restartFeed{results: make(chan feedResult, 1)}
	second := &restartFeed{results: make(chan feedResult)}
	store := &restartStore{feeds: []roomFeed{first, second}, replayErr: redisroom.ErrGap}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &eventSink{events: make(chan protocol.Event, 8)}
	if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	if event := waitRoomEvent(t, sink.events); event.Type != protocol.EventSubscribed {
		t.Fatalf("first event = %q, want subscribed", event.Type)
	}
	first.results <- feedResult{err: errors.New("feed disconnected")}
	for range 2 {
		if event := waitRoomEvent(t, sink.events); event.Type != protocol.EventRecoveryFailed {
			t.Fatalf("outage event = %q, want recovery_failed", event.Type)
		}
	}
	entry, _, _ := rooms.roomPosition("group:chat")
	entry.positionMu.Lock()
	defer entry.positionMu.Unlock()
	if _, _, last := rooms.roomPosition("group:chat"); last != "3-0" {
		t.Fatalf("room position = %q, want 3-0", last)
	}
}

func waitRoomEvent(t *testing.T, events <-chan protocol.Event) protocol.Event {
	t.Helper()
	select {
	case event := <-events:
		return event
	case <-time.After(3 * time.Second):
		t.Fatal("timed out waiting for Room event")
		return protocol.Event{}
	}
}
