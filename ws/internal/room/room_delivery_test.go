package room

import (
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
	m.deliver(sink, protocol.Event{Type: "message_saved", EventID: "duplicate"}, 8)
	m.deliver(sink, protocol.Event{Type: "message_saved", EventID: "buffered"}, 8)
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
		m.deliver(sink, protocol.Event{Type: "message_saved", EventID: "live"}, 8)
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
