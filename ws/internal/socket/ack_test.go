package socket

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"messenger/ws/internal/monitoring"
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

func TestACKDeadlineFollowsOutstandingReceipts(t *testing.T) {
	tracker := newACKTracker(4, time.Minute)
	start := time.Now()
	if deadline := tracker.nextDeadline(); !deadline.IsZero() {
		t.Fatal("idle tracker has a deadline")
	}
	for index, chat := range []string{"first", "second"} {
		if err := tracker.markSent(savedEvent(chat, "1"), start.Add(time.Duration(index)*time.Second)); err != nil {
			t.Fatal(err)
		}
	}
	if err := tracker.receivedMessage("first", "1"); err != nil {
		t.Fatal(err)
	}
	if deadline := tracker.nextDeadline(); !deadline.Equal(start.Add(time.Minute + time.Second)) {
		t.Fatalf("deadline = %s", deadline)
	}
	if err := tracker.apply("second", "1"); err != nil {
		t.Fatal(err)
	}
	if deadline := tracker.nextDeadline(); !deadline.IsZero() {
		t.Fatal("fully acknowledged tracker has a deadline")
	}
}

func TestACKMetricsDistinguishApplicationFromReceiptAndReleaseOnClose(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := monitoring.New(registry)
	tracker := newACKTracker(8, time.Second)
	tracker.metrics = metrics
	value := func() float64 {
		m := &dto.Metric{}
		if err := metrics.PendingACKs.Write(m); err != nil {
			t.Fatal(err)
		}
		return m.GetGauge().GetValue()
	}
	now := time.Now()
	for _, sequence := range []string{"1", "2", "3"} {
		event := savedEvent("chat", sequence)
		event.CreatedAt = now.Add(-time.Second).Format(time.RFC3339Nano)
		if err := tracker.markSent(event, now); err != nil {
			t.Fatal(err)
		}
	}
	if got := value(); got != 3 {
		t.Fatalf("pending %v", got)
	}
	if err := tracker.receivedMessage("chat", "1"); err != nil {
		t.Fatal(err)
	}
	if err := tracker.apply("chat", "2"); err != nil {
		t.Fatal(err)
	}
	if got := value(); got != 1 {
		t.Fatalf("pending after receipt/apply %v", got)
	}
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	count := uint64(0)
	for _, family := range families {
		if family.GetName() == "messenger_ws_applied_latency_seconds" {
			for _, metric := range family.Metric {
				count += metric.GetHistogram().GetSampleCount()
			}
		}
	}
	if count != 2 {
		t.Fatalf("want one saved and one offered observation, got %d", count)
	}
	tracker.close()
	tracker.close()
	if got := value(); got != 0 {
		t.Fatalf("pending after close %v", got)
	}
	if err := tracker.markSent(savedEvent("chat", "4"), now); err == nil {
		t.Fatal("closed tracker admitted notification")
	}
}
