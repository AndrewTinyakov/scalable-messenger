package room

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type delayedReplayStore struct {
	started chan struct{}
	release chan struct{}
	replays atomic.Int32
}

func TestConcurrentMembershipChangesPreserveAdmission(t *testing.T) {
	feed := &restartFeed{results: make(chan feedResult, 64)}
	rooms := newRooms(&frameRoomStore{feed: feed}, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	rooms.maxRooms, rooms.maxMemberships = 1, 17
	t.Cleanup(rooms.Close)
	anchor := &positionSink{}
	if err := rooms.Join(context.Background(), anchor, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	errors := make(chan error, 16)
	var workers sync.WaitGroup
	for range 16 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			sink := &positionSink{}
			for range 30 {
				if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
					errors <- err
					return
				}
				rooms.LeaveAll(sink)
			}
		}()
	}
	for i := 2; i < 32; i++ {
		feed.results <- feedResult{live: positionLive(fmt.Sprintf("%d-0", i), fmt.Sprintf("%d-0", i-1))}
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		t.Fatal(err)
	}
	rooms.LeaveAll(anchor)
	if err := rooms.Join(context.Background(), &positionSink{}, "group:next", "chat", "epoch", "1-0"); err != nil {
		t.Fatalf("concurrent departures did not release room capacity: %v", err)
	}
}

func (*delayedReplayStore) Subscribe(context.Context, string) (roomFeed, error) {
	return &controlledRoomFeed{}, nil
}
func (*delayedReplayStore) Tail(context.Context, string) (string, string, error) {
	return "epoch", "1-0", nil
}
func (store *delayedReplayStore) Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
	if store.replays.Add(1) == 1 {
		close(store.started)
		<-store.release
		return []redisroom.Live{{Event: protocol.Event{Type: protocol.EventMessageSaved, EventID: "old-membership"}}}, nil
	}
	return nil, nil
}

func TestLateReplayCannotReachReplacementMembership(t *testing.T) {
	store := &delayedReplayStore{started: make(chan struct{}), release: make(chan struct{})}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &positionSink{}
	first := make(chan error, 1)
	go func() { first <- rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0") }()
	select {
	case <-store.started:
	case <-time.After(time.Second):
		t.Fatal("first replay did not start")
	}
	rooms.LeaveAll(sink)
	if err := rooms.Join(context.Background(), sink, "group:chat", "chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	close(store.release)
	select {
	case err := <-first:
		if err == nil {
			t.Fatal("departed membership completed a late replay")
		}
	case <-time.After(time.Second):
		t.Fatal("late replay did not stop")
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.events) != 1 || sink.events[0].Type != protocol.EventSubscribed {
		t.Fatalf("replacement membership received %+v", sink.events)
	}
}

func TestWaitingJoinCannotExposeAnUnprotectedSubscription(t *testing.T) {
	rooms := newRooms(&frameRoomStore{feed: &restartFeed{results: make(chan feedResult)}}, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	t.Cleanup(rooms.Close)
	sink := &positionSink{}
	if err := rooms.Join(context.Background(), sink, "user:member", "first-chat", "epoch", "1-0"); err != nil {
		t.Fatal(err)
	}
	entry := rooms.lookup("user:member")
	entry.mu.Lock()
	member := entry.members[sink]
	entry.mu.Unlock()
	member.joinMu.Lock()
	joined := make(chan error, 1)
	go func() { joined <- rooms.Join(context.Background(), sink, "user:member", "next-chat", "epoch", "1-0") }()
	exposed := false
	deadline := time.Now().Add(100 * time.Millisecond)
	for time.Now().Before(deadline) {
		entry.mu.Lock()
		exposed = member.chatIDs["next-chat"] && !member.catching.Load()
		entry.mu.Unlock()
		if exposed {
			break
		}
		time.Sleep(time.Millisecond)
	}
	member.joinMu.Unlock()
	select {
	case err := <-joined:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("waiting join did not finish")
	}
	if exposed {
		t.Fatal("additional chat became visible before its replay barrier was armed")
	}
}
