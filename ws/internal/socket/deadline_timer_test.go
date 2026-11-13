package socket

import (
	"testing"
	"time"
)

func TestDeadlineTimerRearmsAfterStopAndExpiry(t *testing.T) {
	var timer deadlineTimer
	defer timer.stop()
	if timer.arm(time.Time{}) != nil {
		t.Fatal("idle timer has a receive channel")
	}
	timer.arm(time.Now().Add(time.Hour))
	if timer.arm(time.Time{}) != nil {
		t.Fatal("stopped timer has a receive channel")
	}
	for range 2 {
		tick := timer.arm(time.Now().Add(time.Millisecond))
		select {
		case <-tick:
		case <-time.After(time.Second):
			t.Fatal("rearmed deadline did not fire")
		}
		timer.stop()
	}
}
