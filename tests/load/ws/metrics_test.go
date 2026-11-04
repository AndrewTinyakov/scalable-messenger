package main

import (
	"fmt"
	"strings"
	"testing"
)

func TestObservedMetricsRejectMissingInvalidAndOverCapacityValues(t *testing.T) {
	var payload strings.Builder
	for gauge, resource := range observedGauges {
		fmt.Fprintf(&payload, "%s 0\nmessenger_ws_capacity{resource=\"%s\"} 8\n", gauge, resource)
	}
	valid := payload.String()
	node, err := parseMetrics("test", []byte(valid))
	if err != nil {
		t.Fatal(err)
	}
	observer := &metricObserver{peak: make(map[string]float64)}
	if err := observer.record([]nodeMetrics{node}); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{"NaN", "+Inf", "invalid"} {
		if _, err := parseMetrics("test", []byte("messenger_ws_connections "+raw)); err == nil {
			t.Fatalf("accepted invalid value %q", raw)
		}
	}
	delete(node.gauges, "messenger_ws_connections")
	if err := observer.record([]nodeMetrics{node}); err == nil {
		t.Fatal("accepted missing connection accounting")
	}
	node.gauges["messenger_ws_connections"] = 9
	if err := observer.record([]nodeMetrics{node}); err == nil {
		t.Fatal("accepted more connections than the exported node limit")
	}
	node.gauges["messenger_ws_connections"] = 0
	node.gauges["messenger_ws_queued_items"] = 65
	if err := observer.record([]nodeMetrics{node}); err == nil {
		t.Fatal("accepted more aggregate outbound items than 8 connections times 8 items")
	}
}
