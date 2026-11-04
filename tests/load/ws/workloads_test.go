package main

import (
	"sync"
	"sync/atomic"
	"testing"
)

func TestConcurrentPublishAttemptsRespectDeclaredBound(t *testing.T) {
	work := &run{opts: options{maxMessages: 37}}
	var workers sync.WaitGroup
	var admitted atomic.Int64
	for range 64 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for work.claimMessage() {
				admitted.Add(1)
			}
		}()
	}
	workers.Wait()
	if admitted.Load() != 37 || work.attempted.Load() != 37 {
		t.Fatalf("attempt limit admitted %d and reserved %d", admitted.Load(), work.attempted.Load())
	}
}
