package socket

import (
	"math/rand/v2"
	"time"
)

// jitteredFirstTick spreads work started by a burst of new connections across
// one normal interval. Callers reset the ticker to that interval after its
// first tick so the long-run rate stays the same.
func jitteredFirstTick(interval time.Duration) time.Duration {
	return time.Duration(rand.Int64N(int64(interval))) + time.Nanosecond
}

type pingScheduleState uint8

const (
	pingJittered pingScheduleState = iota
	pingSteady
)
