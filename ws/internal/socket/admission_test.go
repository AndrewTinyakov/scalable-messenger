package socket

import (
	"sync"
	"sync/atomic"
	"testing"

	"messenger/ws/internal/config"
)

func TestConcurrentUpgradesReserveConnectionCapacity(t *testing.T) {
	const limit = 4
	server := &Server{config: config.Config{MaxConnections: limit}, connections: make(map[*Connection]struct{})}
	start := make(chan struct{})
	var accepted atomic.Int32
	var workers sync.WaitGroup
	for range 100 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			<-start
			if server.reserveUpgrade() {
				accepted.Add(1)
			}
		}()
	}
	close(start)
	workers.Wait()
	if got := accepted.Load(); got != limit {
		t.Fatalf("reserved upgrades = %d, want %d", got, limit)
	}
	if got := server.pendingUpgrades; got != limit {
		t.Fatalf("in-flight upgrades = %d, want %d", got, limit)
	}
	for range limit {
		server.releaseUpgrade()
	}
	if !server.reserveUpgrade() {
		t.Fatal("released capacity could not be reserved again")
	}
}
