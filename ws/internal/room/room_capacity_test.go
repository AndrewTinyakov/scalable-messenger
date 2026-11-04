package room

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/monitoring"
)

func TestRoomAdmissionReusesCapacityAfterLeaveAll(t *testing.T) {
	store := &controlledRoomStore{feed: &controlledRoomFeed{}}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	rooms.maxRooms, rooms.maxMemberships = 1, 2
	t.Cleanup(rooms.Close)
	first, second, third := &positionSink{}, &positionSink{}, &positionSink{}
	join := func(sink Recipient, room string) error {
		return rooms.Join(context.Background(), sink, room, "chat", "epoch", "1-0")
	}
	if err := join(first, "group:first"); err != nil {
		t.Fatal(err)
	}
	if err := join(second, "group:first"); err != nil {
		t.Fatal(err)
	}
	if err := join(third, "group:first"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("membership capacity error = %v", err)
	}
	rooms.LeaveAll(first)
	if err := join(third, "group:first"); err != nil {
		t.Fatalf("released membership could not be reused: %v", err)
	}
	if err := join(first, "group:second"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("room capacity error = %v", err)
	}
	rooms.LeaveAll(second)
	rooms.LeaveAll(third)
	if err := join(first, "group:second"); err != nil {
		t.Fatalf("released room could not be reused: %v", err)
	}
}

func TestDirectChatsShareOneRoomMembershipBudget(t *testing.T) {
	store := &controlledRoomStore{feed: &controlledRoomFeed{}}
	rooms := newRooms(store, slog.New(slog.NewTextHandler(io.Discard, nil)), 8, 8, 4096, time.Second, monitoring.New(prometheus.NewRegistry()))
	rooms.maxRooms, rooms.maxMemberships = 1, 1
	t.Cleanup(rooms.Close)
	first, second := &positionSink{}, &positionSink{}
	for _, chat := range []string{"first-chat", "second-chat"} {
		if err := rooms.Join(context.Background(), first, "user:member", chat, "epoch", "1-0"); err != nil {
			t.Fatal(err)
		}
	}
	rooms.LeaveChat(first, "user:member", "first-chat")
	if err := rooms.Join(context.Background(), second, "user:member", "chat", "epoch", "1-0"); !errors.Is(err, ErrCapacity) {
		t.Fatalf("partially retained membership admission = %v", err)
	}
	rooms.LeaveChat(first, "user:member", "second-chat")
	if err := rooms.Join(context.Background(), second, "user:member", "chat", "epoch", "1-0"); err != nil {
		t.Fatalf("final departure did not release membership: %v", err)
	}
}
