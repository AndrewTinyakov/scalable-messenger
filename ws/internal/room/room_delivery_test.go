package room

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"messenger/ws/internal/protocol"
)

type blockingSink struct {
	mu      sync.Mutex
	events  []protocol.Event
	blocked chan struct{}
	release chan struct{}
}

func (sink *blockingSink) Enqueue(event protocol.Event) bool {
	if event.EventID == "buffered" {
		close(sink.blocked)
		<-sink.release
	}
	sink.mu.Lock()
	sink.events = append(sink.events, event)
	sink.mu.Unlock()
	return true
}

func TestReplayDrainPrecedesConcurrentLiveFanout(t *testing.T) {
	m := newRoomMember()
	sink := &blockingSink{blocked: make(chan struct{}), release: make(chan struct{})}
	m.deliver(sink, protocol.Event{Type: "message_saved", EventID: "duplicate"}, 8, 4096)
	m.deliver(sink, protocol.Event{Type: "message_saved", EventID: "buffered"}, 8, 4096)
	finishDone := make(chan struct{})
	go func() {
		m.finish(sink, "group:room", []string{"chat"}, []protocol.Event{{EventID: "duplicate"}})
		close(finishDone)
	}()
	select {
	case <-sink.blocked:
	case <-time.After(time.Second):
		t.Fatal("buffer drain did not start")
	}
	liveStarted, liveDone := make(chan struct{}), make(chan struct{})
	go func() {
		close(liveStarted)
		m.deliver(sink, protocol.Event{Type: "message_saved", EventID: "live"}, 8, 4096)
		close(liveDone)
	}()
	<-liveStarted
	select {
	case <-liveDone:
		t.Fatal("live delivery overtook a blocked replay drain")
	case <-time.After(30 * time.Millisecond):
	}
	close(sink.release)
	select {
	case <-finishDone:
	case <-time.After(time.Second):
		t.Fatal("replay drain did not finish")
	}
	select {
	case <-liveDone:
	case <-time.After(time.Second):
		t.Fatal("live delivery did not finish")
	}
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.events) != 3 {
		t.Fatalf("events = %+v, want buffered, subscribed, live", sink.events)
	}
	if sink.events[0].EventID != "buffered" || sink.events[1].Type != "subscribed" || sink.events[2].EventID != "live" {
		t.Fatalf("events = %+v, want buffered, subscribed, live", sink.events)
	}
}

func TestCatchupBufferRejectsByteOverflow(t *testing.T) {
	m := newRoomMember()
	sink := &blockingSink{}
	event := protocol.Event{Type: protocol.EventMessageSaved, Body: "a long saved message"}
	payload, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	if m.deliver(sink, event, 8, 2*len(payload)-1) {
		t.Fatal("first event exceeded byte limit")
	}
	if !m.deliver(sink, event, 8, 2*len(payload)-1) {
		t.Fatal("second event exceeded byte limit without recovery")
	}
	if len(m.buffer) != 0 || m.bufferBytes != 0 {
		t.Fatalf("overflow retained %d events and %d bytes", len(m.buffer), m.bufferBytes)
	}
}

func TestCatchupDrainCannotRestoreDepartedMember(t *testing.T) {
	member := newRoomMember()
	sink := &blockingSink{blocked: make(chan struct{}), release: make(chan struct{})}
	member.deliver(sink, protocol.Event{Type: protocol.EventMessageSaved, EventID: "buffered"}, 8, 4096)
	done := make(chan struct{})
	go func() {
		member.finish(sink, "group:room", []string{"chat"}, nil)
		close(done)
	}()
	select {
	case <-sink.blocked:
	case <-time.After(time.Second):
		t.Fatal("catch-up drain did not start")
	}
	member.leave()
	close(sink.release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("catch-up drain did not finish")
	}
	member.beginCatchup()
	member.deliver(sink, protocol.Event{Type: protocol.EventMessageSaved, EventID: "late"}, 8, 4096)
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.events) != 1 || sink.events[0].EventID != "buffered" {
		t.Fatalf("departed member received %+v", sink.events)
	}
}
