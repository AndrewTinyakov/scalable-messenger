package room

import (
	"context"
	"testing"

	"messenger/ws/internal/protocol"
)

type personalRoomSink struct {
	positionSink
	closed bool
}

func (sink *personalRoomSink) Close() {
	sink.closed = true
}

func newPersonalRoom(t *testing.T) (*Rooms, *personalRoomSink) {
	t.Helper()
	rooms := newPositionRooms(&positionStore{})
	sink := &personalRoomSink{}
	addPositionRoom(rooms, "user:member", &sink.positionSink)
	entry := rooms.rooms["user:member"]
	member := entry.members[&sink.positionSink]
	delete(entry.members, &sink.positionSink)
	entry.members[sink] = member
	return rooms, sink
}

func TestPersonalRoomEpochChangeClosesSocket(t *testing.T) {
	rooms, sink := newPersonalRoom(t)
	live := positionLive("1-0", "")
	live.Epoch = "new-epoch"
	live.Event.Epoch = live.Epoch
	rooms.handleLive(context.Background(), "user:member", live)
	if !sink.closed {
		t.Fatal("socket stayed open after its revocation history changed epoch")
	}
	if len(sink.events) != 0 {
		t.Fatalf("events after revocation history loss = %+v, want none", sink.events)
	}
}

func TestPersonalRoomReplayOverflowClosesSocket(t *testing.T) {
	rooms, sink := newPersonalRoom(t)
	rooms.bufferLimit = 1
	member := rooms.rooms["user:member"].members[sink]
	member.beginCatchup()
	for _, id := range []string{"2-0", "3-0"} {
		rooms.dispatch("user:member", protocol.Event{Type: protocol.EventSessionRevoked, EventID: id, Epoch: "epoch", StreamID: id})
	}
	if !sink.closed {
		t.Fatal("socket stayed open after its revocation event buffer overflowed")
	}
}

func TestGroupRoomGapClosesSocketBeforeLaterMessages(t *testing.T) {
	rooms := newPositionRooms(&positionStore{})
	sink := &personalRoomSink{}
	addPositionRoom(rooms, "group:chat", &sink.positionSink)
	entry := rooms.rooms["group:chat"]
	member := entry.members[&sink.positionSink]
	delete(entry.members, &sink.positionSink)
	entry.members[sink] = member
	live := positionLive("1-0", "")
	live.Epoch = "new-epoch"
	live.Event.Epoch = live.Epoch
	rooms.handleLive(context.Background(), "group:chat", live)
	if !sink.closed {
		t.Fatal("socket stayed open after group stream lost a removal event")
	}
	if len(sink.events) != 0 {
		t.Fatalf("events after group gap = %+v, want none", sink.events)
	}
}
