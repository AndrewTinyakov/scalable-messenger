package socket

import (
	"context"
	"net/http"
	"time"
)

func (s *Server) ready(w http.ResponseWriter, _ *http.Request) {
	s.mu.Lock()
	ready := !s.closing && !s.draining && (s.config.MaxConnections <= 0 || len(s.connections)+s.pendingUpgrades < s.config.MaxConnections)
	s.mu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	if !ready {
		w.WriteHeader(http.StatusServiceUnavailable)
		w.Write([]byte(`{"status":"unavailable"}`))
		return
	}
	w.Write([]byte(`{"status":"ready"}`))
}

func (s *Server) Drain(ctx context.Context) {
	s.mu.Lock()
	s.draining = true
	s.metrics.Draining.Set(1)
	connections := make([]*Connection, 0, len(s.connections))
	for connection := range s.connections {
		connections = append(connections, connection)
	}
	s.mu.Unlock()
	duration := s.config.DrainTimeout
	if duration <= 0 {
		for _, connection := range connections {
			connection.Close()
		}
		return
	}
	if len(connections) == 0 {
		return
	}
	started := time.Now()
	ticker := time.NewTicker(min(10*time.Millisecond, duration))
	defer ticker.Stop()
	closed := 0
	for closed < len(connections) {
		select {
		case <-ctx.Done():
			for _, connection := range connections[closed:] {
				connection.Close()
			}
			return
		case now := <-ticker.C:
			target := min(len(connections), int(float64(len(connections))*float64(now.Sub(started))/float64(duration)))
			for closed < target {
				connections[closed].Close()
				closed++
			}
		}
	}
}
