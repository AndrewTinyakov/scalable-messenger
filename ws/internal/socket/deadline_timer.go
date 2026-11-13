package socket

import "time"

type deadlineTimerState uint8

const (
	deadlineTimerUnused deadlineTimerState = iota
	deadlineTimerStopped
	deadlineTimerArmed
)

type deadlineTimer struct {
	state    deadlineTimerState
	timer    *time.Timer
	deadline time.Time
}

func (timer *deadlineTimer) arm(deadline time.Time) <-chan time.Time {
	if deadline.IsZero() {
		timer.stop()
		return nil
	}
	if timer.state == deadlineTimerUnused {
		timer.timer = time.NewTimer(time.Until(deadline))
	} else if timer.state != deadlineTimerArmed || !deadline.Equal(timer.deadline) {
		timer.timer.Reset(time.Until(deadline))
	}
	timer.state = deadlineTimerArmed
	timer.deadline = deadline
	return timer.timer.C
}

func (timer *deadlineTimer) stop() {
	if timer.state == deadlineTimerUnused {
		return
	}
	timer.timer.Stop()
	timer.state = deadlineTimerStopped
	timer.deadline = time.Time{}
}
