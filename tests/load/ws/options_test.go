package main

import (
	"testing"
	"time"
)

func TestInvalidSenderAndBootstrapCountsFailBeforeProvisioning(t *testing.T) {
	opts := options{mode: "fanout", connections: 1, senders: 1, payloadBytes: 80, maxMessages: 1, rate: 1, ramp: 1, duration: time.Second, setupTimeout: time.Second, verificationTimeout: time.Second}
	if err := opts.validate(); err != nil {
		t.Fatal(err)
	}
	opts.senders = 2
	if err := opts.validate(); err == nil {
		t.Fatal("accepted more distinct senders than sockets")
	}
	opts.senders = 1
	opts.bootstrapUsers = 1000001
	if err := opts.validate(); err == nil {
		t.Fatal("accepted provisioning beyond the supported workload scale")
	}
}

func TestLatencyAndTraceOptionsRejectInvalidBounds(t *testing.T) {
	opts := options{mode: "fanout", connections: 1, senders: 1, payloadBytes: 80, maxMessages: 1, rate: 1, ramp: 1, duration: time.Second, setupTimeout: time.Second, verificationTimeout: time.Second}
	opts.p99Limit = -time.Nanosecond
	if err := opts.validate(); err == nil {
		t.Fatal("accepted a negative p99 limit")
	}
	opts.p99Limit = 200 * time.Millisecond
	opts.traceFile = "trace.ndjson"
	if err := opts.validate(); err == nil {
		t.Fatal("accepted zero trace sampling interval")
	}
	opts.traceSampleEvery = 16
	if err := opts.validate(); err != nil {
		t.Fatal(err)
	}
}
