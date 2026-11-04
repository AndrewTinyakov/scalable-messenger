package main

import (
	"sort"
	"sync/atomic"
	"time"
)

var latencyBounds = func() [1005]time.Duration {
	var bounds [1005]time.Duration
	for index := range 1000 {
		bounds[index] = time.Duration(index+1) * time.Millisecond
	}
	copy(bounds[1000:], []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 20 * time.Second, time.Minute})
	return bounds
}()

func (work *run) observe(latency time.Duration) {
	work.latencyObserved.Add(1)
	if work.opts.p95Limit > 0 && latency > work.opts.p95Limit {
		work.latencySlow.Add(1)
	}
	if work.opts.p99Limit > 0 && latency > work.opts.p99Limit {
		work.latencyP99Slow.Add(1)
	}
	index := sort.Search(len(latencyBounds), func(index int) bool { return latency <= latencyBounds[index] })
	work.latency[index].Add(1)
}

func (work *run) report() map[string]any {
	missing, received, duplicates, connected := int64(0), int64(0), int64(0), 0
	for _, socket := range work.clients {
		if socket.connected.Load() {
			connected++
		}
		received += socket.delivered.Load()
		duplicates += socket.duplicates.Load()
		if !socket.slow {
			if work.mixed != nil {
				for _, progress := range socket.chats {
					missing += max(0, progress.chat.sent.Load()-progress.delivered.Load())
				}
			} else {
				missing += max(0, work.sent.Load()-socket.delivered.Load())
			}
		}
	}
	quantile := func(percent int64) any {
		count := int64(0)
		for index := range work.latency {
			count += work.latency[index].Load()
		}
		if count == 0 {
			return nil
		}
		target, accumulated := (count*percent+99)/100, int64(0)
		for index, bound := range latencyBounds {
			accumulated += work.latency[index].Load()
			if accumulated >= target {
				return bound.String()
			}
		}
		return ">1m"
	}
	codes := make(map[string]int64)
	work.errorCodes.Range(func(key, value any) bool { codes[key.(string)] = value.(*atomic.Int64).Load(); return true })
	report := map[string]any{"latencyP99SLO": map[string]any{"limit": work.opts.p99Limit.String(), "observed": work.latencyObserved.Load(), "overLimit": work.latencyP99Slow.Load(), "passed": work.latencyP99SLOMet()}, "latencySLO": map[string]any{"limit": work.opts.p95Limit.String(), "observed": work.latencyObserved.Load(), "overLimit": work.latencySlow.Load(), "passed": work.latencySLOMet()}, "errorCodes": codes, "mode": work.opts.mode, "connections": len(work.clients), "connectedAtEnd": connected, "attempted": work.attempted.Load(), "sent": work.sent.Load(), "queued": work.queued.Load(), "receivedNotifications": received, "duplicateNotifications": duplicates, "missingHealthyNotifications": missing, "errorFramesAndFailures": work.errors.Load(), "closedSockets": work.closes.Load(), "reconnects": work.reconnect.Load(), "latencyUpperBounds": map[string]any{"p50": quantile(50), "p95": quantile(95), "p99": quantile(99)}, "duration": work.opts.duration.String()}
	if work.mixed != nil {
		report["scenario"] = work.mixedReport()
	}
	return report
}

func (work *run) latencySLOMet() bool {
	return work.opts.p95Limit == 0 || (work.latencyObserved.Load() > 0 && work.latencySlow.Load()*100 <= work.latencyObserved.Load()*5)
}

func (work *run) latencyP99SLOMet() bool {
	return work.opts.p99Limit == 0 || (work.latencyObserved.Load() > 0 && work.latencyP99Slow.Load()*100 <= work.latencyObserved.Load())
}
