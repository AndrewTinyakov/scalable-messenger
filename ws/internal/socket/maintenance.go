package socket

import (
	"messenger/ws/internal/monitoring"
)

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
		for range workers {
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.commands.run() }()
		}
		s.wg.Add(1)
		go func() { defer s.wg.Done(); s.checkSessions() }()
		if s.sidebar != nil {
			s.wg.Add(1)
			go func() { defer s.wg.Done(); s.sidebar.run() }()
		}
	})
}
