package socket

import (
	"math/rand/v2"
	"time"
)

func jitteredFirstTick(interval time.Duration) time.Duration {
	return time.Duration(rand.Int64N(int64(interval))) + time.Nanosecond
}

type pingScheduleState uint8

const (
	pingJittered pingScheduleState = iota
	pingSteady
)
