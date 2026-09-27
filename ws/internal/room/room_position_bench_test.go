package room

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"
)

// This measures the sweep scheduler with fixed Tail latency. It does not
// substitute for a Redis Cluster load test.
func BenchmarkPositionSweep(b *testing.B) {
	for _, roomCount := range []int{1000, 10000} {
		for _, tailLatency := range []time.Duration{0, time.Millisecond, 10 * time.Millisecond} {
			b.Run(fmt.Sprintf("rooms=%d/tail=%s", roomCount, tailLatency), func(b *testing.B) {
				var active atomic.Int64
				var peak atomic.Int64
				var reads atomic.Int64
				store := &positionStore{tail: func(ctx context.Context, _ string) (string, string, error) {
					reads.Add(1)
					current := active.Add(1)
					for maximum := peak.Load(); current > maximum; maximum = peak.Load() {
						if peak.CompareAndSwap(maximum, current) {
							break
						}
					}
					defer active.Add(-1)
					if tailLatency > 0 {
						timer := time.NewTimer(tailLatency)
						defer timer.Stop()
						select {
						case <-timer.C:
						case <-ctx.Done():
							return "", "", ctx.Err()
						}
					}
					return "epoch", "1-0", nil
				}}
				rooms := newPositionRooms(store)
				rooms.checkInterval = 30 * time.Second
				for i := range roomCount {
					addPositionRoom(rooms, fmt.Sprintf("user:%d", i), &positionSink{})
				}
				b.ResetTimer()
				for b.Loop() {
					rooms.checkAll(context.Background())
				}
				b.StopTimer()
				b.ReportMetric(float64(reads.Load())/float64(b.N), "reads/sweep")
				b.ReportMetric(float64(peak.Load()), "peak-reads")
			})
		}
	}
}
