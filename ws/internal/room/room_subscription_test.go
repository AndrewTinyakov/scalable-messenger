package room

import (
	"testing"
	"time"
)

func TestSubscriptionRetryDelayUsesCappedJitter(t *testing.T) {
	for _, tc := range []struct {
		attempt int
		min     time.Duration
		max     time.Duration
	}{
		{0, 500 * time.Millisecond, time.Second},
		{1, time.Second, 2 * time.Second},
		{5, 15 * time.Second, 30 * time.Second},
		{100, 15 * time.Second, 30 * time.Second},
	} {
		delay := subscriptionRetryDelay(tc.attempt)
		if delay < tc.min || delay >= tc.max {
			t.Errorf("attempt %d delay %s outside [%s, %s)", tc.attempt, delay, tc.min, tc.max)
		}
	}
}
