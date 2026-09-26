package socket

import (
	"errors"
	"testing"
	"time"

	"messenger/ws/internal/protocol"
)

func savedEvent(conversationID, sequence string) protocol.Event {
	return protocol.Event{Type: "message_saved", ConversationID: conversationID, Sequence: sequence}
}

func TestACKTrackerExpiresOnlyUnappliedMessages(t *testing.T) {
	start := time.Date(2026, 9, 26, 10, 0, 0, 0, time.UTC)
	tracker := newACKTracker(2, 30*time.Second)
	if err := tracker.markSent(savedEvent("one", "1"), start); err != nil {
		t.Fatal(err)
	}
	if err := tracker.markSent(savedEvent("one", "2"), start.Add(time.Second)); err != nil {
		t.Fatal(err)
	}
	if err := tracker.apply("one", "1"); err != nil {
		t.Fatal(err)
	}
	if got := tracker.expired(start.Add(30 * time.Second)); len(got) != 0 {
		t.Fatalf("expired = %v, want none", got)
	}
	if got := tracker.expired(start.Add(31 * time.Second)); len(got) != 1 || got[0] != "one" {
		t.Fatalf("expired = %v, want [one]", got)
	}
	if err := tracker.apply("one", "2"); err != nil {
		t.Fatal(err)
	}
	if tracker.applied["one"] != 2 {
		t.Fatalf("applied = %d, want 2", tracker.applied["one"])
	}
	if got := tracker.expired(start.Add(time.Hour)); len(got) != 0 {
		t.Fatalf("expired after ACK = %v, want none", got)
	}
}

func TestACKTrackerBoundsPendingAndDeduplicatesReplay(t *testing.T) {
	tracker := newACKTracker(1, time.Minute)
	now := time.Now()
	if err := tracker.markSent(savedEvent("one", "1"), now); err != nil {
		t.Fatal(err)
	}
	if err := tracker.markSent(savedEvent("one", "1"), now.Add(time.Second)); err != nil {
		t.Fatalf("duplicate replay: %v", err)
	}
	if err := tracker.markSent(savedEvent("one", "2"), now); !errors.Is(err, errPendingACKLimit) {
		t.Fatalf("limit error = %v, want errPendingACKLimit", err)
	}
	if err := tracker.apply("one", "1"); err != nil {
		t.Fatal(err)
	}
	if err := tracker.markSent(savedEvent("one", "2"), now); err != nil {
		t.Fatalf("after ACK: %v", err)
	}
}
