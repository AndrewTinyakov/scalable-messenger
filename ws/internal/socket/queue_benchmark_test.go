package socket

import "testing"

var benchmarkOutboundQueue chan outbound

func BenchmarkOutboundQueueAllocation(b *testing.B) {
	b.ReportAllocs()
	for b.Loop() {
		benchmarkOutboundQueue = make(chan outbound, 128)
	}
}
