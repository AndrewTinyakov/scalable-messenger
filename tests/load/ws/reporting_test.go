package main

import (
	"testing"
	"time"
)

func TestVerificationWaitsForPublisherConfirmationAndAllReaders(t *testing.T) {
	work := &run{}
	first, second := &client{}, &client{}
	first.connected.Store(true)
	second.connected.Store(true)
	work.clients = []*client{first, second}
	work.sent.Store(2)
	first.delivered.Store(2)
	second.delivered.Store(2)
	if work.complete() {
		t.Fatal("completed before both publish confirmations")
	}
	work.queued.Store(2)
	second.delivered.Store(1)
	if work.complete() {
		t.Fatal("completed while one reader was missing a notification")
	}
	second.delivered.Store(2)
	if !work.complete() {
		t.Fatal("failed to complete after confirmations and contiguous reader progress")
	}
}

func TestLatencyLimitRejectsSlowTailEvenWhenDeliveryCompletes(t *testing.T) {
	work := &run{opts: options{p95Limit: 200 * time.Millisecond}}
	for range 19 {
		work.observe(150 * time.Millisecond)
	}
	work.observe(time.Second)
	if !work.latencySLOMet() {
		t.Fatal("exactly five percent slow should pass p95")
	}
	work.observe(time.Second)
	if work.latencySLOMet() {
		t.Fatal("complete delivery must not hide a slow tail")
	}
}

func TestLatencyQuantilesResolveSubsecondTailToOneMillisecond(t *testing.T) {
	work := &run{}
	for range 98 {
		work.observe(123*time.Millisecond + time.Nanosecond)
	}
	work.observe(237*time.Millisecond + time.Nanosecond)
	work.observe(999*time.Millisecond + time.Nanosecond)
	bounds := work.report()["latencyUpperBounds"].(map[string]any)
	if bounds["p50"] != "124ms" || bounds["p95"] != "124ms" || bounds["p99"] != "238ms" {
		t.Fatalf("unexpected subsecond quantile bounds: %v", bounds)
	}
}

func TestLatencyQuantileBoundsIncludeExactValuesAndRetainLongTails(t *testing.T) {
	for _, test := range []struct {
		latency time.Duration
		want    string
	}{
		{time.Nanosecond, "1ms"},
		{200 * time.Millisecond, "200ms"},
		{200*time.Millisecond + time.Nanosecond, "201ms"},
		{999*time.Millisecond + time.Nanosecond, "1s"},
		{time.Second + time.Nanosecond, "2s"},
		{time.Minute, "1m0s"},
		{time.Minute + time.Nanosecond, ">1m"},
	} {
		t.Run(test.latency.String(), func(t *testing.T) {
			work := &run{}
			work.observe(test.latency)
			bounds := work.report()["latencyUpperBounds"].(map[string]any)
			if bounds["p99"] != test.want {
				t.Fatalf("p99 = %v, want %s", bounds["p99"], test.want)
			}
		})
	}
}

func TestP99LimitAllowsOnePercentAndCountsOnlyStrictlySlowerNotifications(t *testing.T) {
	work := &run{opts: options{p99Limit: 200 * time.Millisecond}}
	if work.latencyP99SLOMet() {
		t.Fatal("enabled p99 gate accepted no observations")
	}
	for range 99 {
		work.observe(200 * time.Millisecond)
	}
	work.observe(200*time.Millisecond + time.Nanosecond)
	if !work.latencyP99SLOMet() {
		t.Fatal("exactly one percent slow must pass p99")
	}
	if !work.latencySLOMet() {
		t.Fatal("disabled p95 gate affected p99")
	}
	work.observe(200*time.Millisecond + time.Nanosecond)
	if work.latencyP99SLOMet() {
		t.Fatal("more than one percent slow passed p99")
	}
	gate := work.report()["latencyP99SLO"].(map[string]any)
	if gate["overLimit"] != int64(2) || gate["observed"] != int64(101) || gate["passed"] != false {
		t.Fatalf("unexpected p99 report: %v", gate)
	}
	if !(&run{}).latencyP99SLOMet() {
		t.Fatal("disabled p99 gate rejected no observations")
	}
}
