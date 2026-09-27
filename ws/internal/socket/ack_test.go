package socket

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"messenger/ws/internal/protocol"
)

func savedEvent(chatID, sequence string) protocol.Event {
	return protocol.Event{Type: "message_saved", ChatID: chatID, Sequence: sequence}
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

func TestACKTrackerDismissalResolvesOnlySkippedInterval(t *testing.T) {
	tracker := newACKTracker(2, time.Minute)
	now := time.Now()
	for _, sequence := range []string{"1", "2"} {
		if err := tracker.markSent(savedEvent("one", sequence), now); err != nil {
			t.Fatal(err)
		}
	}
	if err := tracker.dismiss("one", "2"); err != nil {
		t.Fatal(err)
	}
	if err := tracker.dismiss("one", "2"); err != nil {
		t.Fatalf("repeated dismissal: %v", err)
	}
	if tracker.count != 0 || tracker.applied["one"] != 0 || tracker.dismissed["one"] != 2 {
		t.Fatalf("unexpected dismissal state: count=%d applied=%d dismissed=%d", tracker.count, tracker.applied["one"], tracker.dismissed["one"])
	}
	if err := tracker.markSent(savedEvent("one", "1"), now); err != nil {
		t.Fatalf("late skipped message: %v", err)
	}
	if err := tracker.markSent(savedEvent("one", "3"), now); err != nil {
		t.Fatal(err)
	}
	if tracker.count != 1 {
		t.Fatalf("future message pending count = %d, want 1", tracker.count)
	}
	if err := tracker.apply("one", "3"); err != nil {
		t.Fatal(err)
	}
	if tracker.count != 0 || tracker.applied["one"] != 3 {
		t.Fatalf("future applied state: count=%d applied=%d", tracker.count, tracker.applied["one"])
	}
}

func TestACKTrackerExactReceiptPreservesRecoveryState(t *testing.T) {
	tracker := newACKTracker(2, time.Minute)
	now := time.Now()
	for _, sequence := range []string{"10", "11"} {
		if err := tracker.markSent(savedEvent("one", sequence), now); err != nil {
			t.Fatal(err)
		}
	}
	if err := tracker.receivedMessage("one", "11"); err != nil {
		t.Fatal(err)
	}
	if err := tracker.receivedMessage("one", "11"); err != nil {
		t.Fatalf("duplicate exact receipt: %v", err)
	}
	if tracker.count != 1 || tracker.applied["one"] != 0 || tracker.dismissed["one"] != 0 {
		t.Fatalf("exact receipt altered recovery state: count=%d applied=%d dismissed=%d", tracker.count, tracker.applied["one"], tracker.dismissed["one"])
	}
	if got := tracker.expired(now.Add(2 * time.Minute)); len(got) != 1 || got[0] != "one" {
		t.Fatalf("unreceived older frame expiration = %v, want [one]", got)
	}
	if err := tracker.receivedMessage("one", "10"); err != nil {
		t.Fatal(err)
	}
	if tracker.count != 0 {
		t.Fatalf("pending count after both exact receipts = %d, want 0", tracker.count)
	}
}

func TestACKTrackerBoundsClientSuppliedChatPositions(t *testing.T) {
	tracker := newACKTracker(1, time.Minute)
	if err := tracker.apply("active", "1"); err != nil {
		t.Fatal(err)
	}
	if err := tracker.markSent(savedEvent("active", "2"), time.Now()); err != nil {
		t.Fatal(err)
	}
	for index := range tracker.positionLimit * 2 {
		if err := tracker.dismiss(fmt.Sprintf("chat-%d", index), "1"); err != nil {
			t.Fatalf("position %d: %v", index, err)
		}
	}
	if len(tracker.positionChats) > tracker.positionLimit || len(tracker.dismissed) > tracker.positionLimit {
		t.Fatalf("position maps grew past limit: known=%d dismissed=%d limit=%d", len(tracker.positionChats), len(tracker.dismissed), tracker.positionLimit)
	}
	if tracker.applied["active"] != 1 || len(tracker.pending["active"]) != 1 {
		t.Fatal("evicted a chat with an outstanding socket frame")
	}
	if err := tracker.dismiss("chat-0", "2"); err != nil {
		t.Fatalf("chat reuse after limit: %v", err)
	}
}
