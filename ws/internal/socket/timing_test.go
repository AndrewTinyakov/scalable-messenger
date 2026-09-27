package socket

import (
	"testing"
	"time"
)

func TestJitteredFirstTickSpreadsWorkWithinInterval(t *testing.T) {
	const interval = 30 * time.Second
	first := jitteredFirstTick(interval)
	var different bool
	for range 100 {
		delay := jitteredFirstTick(interval)
		if delay <= 0 || delay > interval {
			t.Fatalf("first tick delay %s outside (0, %s]", delay, interval)
		}
		if delay != first {
			different = true
		}
	}
	if !different {
		t.Fatal("all first ticks had the same delay")
	}
}
