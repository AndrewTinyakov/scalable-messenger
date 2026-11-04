package socket

import (
	"context"
	"sync"
	"time"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/redisroom"
)

type leaseRelease struct {
	userID  string
	leaseID string
}
type leaseCleanup struct {
	server *Server
	mu     sync.Mutex
	jobs   chan leaseRelease
	closed bool
	wg     sync.WaitGroup
}

type connectionLeaseBatcher interface {
	RenewConnectionLeases(context.Context, []redisroom.ConnectionLease) []redisroom.ConnectionLeaseResult
}

func (s *Server) startRuntime() {
	s.runtimeOnce.Do(func() {
		items := s.config.CommandQueueItems
		if items <= 0 {
			items = 4096
		}
		bytes := s.config.CommandQueueBytes
		if bytes <= 0 {
			bytes = 16777216
		}
		workers := s.config.CommandWorkers
		if workers <= 0 {
			workers = 4
		}
		for resource, limit := range map[monitoring.CapacityResource]int{monitoring.CapacityConnections: s.config.MaxConnections, monitoring.CapacityRooms: s.config.MaxRooms, monitoring.CapacityMemberships: s.config.MaxMemberships, monitoring.CapacityCommandItems: items, monitoring.CapacityCommandBytes: bytes, monitoring.CapacityOutboundItemsPerConnection: s.config.QueueItems, monitoring.CapacityOutboundBytesPerConnection: s.config.QueueBytes} {
			s.metrics.SetCapacity(resource, limit)
		}
		s.commands = &commandQueue{server: s, maxItems: items, maxBytes: bytes, ready: make(chan *Connection, items)}
		s.cleanup = &leaseCleanup{server: s, jobs: make(chan leaseRelease, 2048)}
		for range workers {
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.commands.run() }()
		}
		for range 8 {
			s.cleanup.wg.Add(1)
			go s.cleanup.run()
		}
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.renewLeases() }()
		if s.sidebar != nil {
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.sidebar.run() }()
		}
		if s.presence != nil {
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.presence.run() }()
		}
	})
}

func (cleanup *leaseCleanup) enqueue(userID, leaseID string) {
	cleanup.mu.Lock()
	defer cleanup.mu.Unlock()
	if cleanup.closed || len(userID)+len(leaseID) > 512 {
		cleanup.server.metrics.LeaseCleanupDropped.Inc()
		return
	}
	select {
	case cleanup.jobs <- leaseRelease{userID: userID, leaseID: leaseID}:
	default:
		cleanup.server.metrics.LeaseCleanupDropped.Inc()
	}
}

func (cleanup *leaseCleanup) run() {
	defer cleanup.wg.Done()
	for job := range cleanup.jobs {
		s := cleanup.server
		s.mu.Lock()
		base := s.leaseCleanupCtx
		s.mu.Unlock()
		if base == nil {
			base = context.Background()
		}
		ctx, cancel := context.WithTimeout(base, time.Second)
		err := s.connectionLeases.ReleaseConnectionLease(ctx, job.userID, job.leaseID)
		cancel()
		if err != nil && s.logger != nil {
			s.logger.Warn("release connection lease", "error", err)
		}
	}
}

func (cleanup *leaseCleanup) close() {
	cleanup.mu.Lock()
	if !cleanup.closed {
		cleanup.closed = true
		close(cleanup.jobs)
	}
	cleanup.mu.Unlock()
	cleanup.wg.Wait()
}

func (s *Server) renewLeases() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case now := <-ticker.C:
			if s.connectionLeases == nil {
				continue
			}
			s.mu.Lock()
			due := make([]*Connection, 0)
			for connection := range s.connections {
				if connection.connectionLeaseID != "" && !now.Before(connection.nextLeaseRenewal) {
					connection.nextLeaseRenewal = now.Add(redisroom.ConnectionLeaseRenewInterval)
					due = append(due, connection)
				}
			}
			s.mu.Unlock()
			timeout := s.config.APITimeout
			if timeout <= 0 {
				timeout = 3 * time.Second
			}
			ctx, cancel := context.WithTimeout(s.ctx, timeout)
			jobs := make(chan []*Connection)
			var renewWG sync.WaitGroup
			for range min(8, (len(due)+127)/128) {
				renewWG.Add(1)
				go func() {
					defer renewWG.Done()
					for batch := range jobs {
						s.renewLeaseBatch(ctx, batch)
					}
				}()
			}
			for start := 0; start < len(due); start += 128 {
				jobs <- due[start:min(start+128, len(due))]
			}
			close(jobs)
			renewWG.Wait()
			cancel()
		}
	}
}

func (s *Server) renewLeaseBatch(ctx context.Context, connections []*Connection) {
	leases := make([]redisroom.ConnectionLease, len(connections))
	for index, connection := range connections {
		leases[index] = redisroom.ConnectionLease{UserID: connection.session.UserID, LeaseID: connection.connectionLeaseID}
	}
	results := make([]redisroom.ConnectionLeaseResult, len(leases))
	if batcher, ok := s.connectionLeases.(connectionLeaseBatcher); ok {
		results = batcher.RenewConnectionLeases(ctx, leases)
	} else {
		for index, lease := range leases {
			active, err := s.connectionLeases.RenewConnectionLease(ctx, lease.UserID, lease.LeaseID)
			results[index] = redisroom.ConnectionLeaseResult{Active: active, Err: err}
		}
	}
	for index, connection := range connections {
		if connection.ctx.Err() != nil {
			continue
		}
		if index >= len(results) || results[index].Err != nil || !results[index].Active {
			connection.Close()
		}
	}
}
