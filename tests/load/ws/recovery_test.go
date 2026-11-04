package main

import (
	"testing"
)

func TestDuplicateLaterSequenceCannotHideMissingNotification(t *testing.T) {
	work := &run{prefix: "capacity_test|"}
	socket := &client{owner: work, sequence: 1}
	for range 2 {
		if err := socket.saved(event{Sequence: "3", Body: "capacity_test|0|"}); err == nil {
			t.Fatal("accepted a notification while sequence 2 was missing")
		}
	}
	if socket.delivered.Load() != 0 || socket.sequence != 1 {
		t.Fatalf("counted a gap as progress: delivered %d, sequence %d", socket.delivered.Load(), socket.sequence)
	}
}
