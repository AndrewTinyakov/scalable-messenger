package socket

import (
	"context"
	"math/rand/v2"
	"sync"
	"time"

	"messenger/ws/internal/grpcauth"
)

const (
	sessionCheckInterval       = 5 * time.Minute
	sessionCheckRetry          = 30 * time.Second
	sessionAuthorizationWindow = 3 * sessionCheckInterval
	sessionCheckBatchSize      = 100
	sessionCheckWorkers        = 4
)

type sessionCheckBatch map[string][]*Connection

func jitteredSessionCheckInterval() time.Duration {
	return sessionCheckInterval*4/5 + time.Duration(rand.Int64N(int64(sessionCheckInterval*2/5)))
}

func (c *Connection) matchesSession(live grpcauth.Session) bool {
	return live.UserID == c.session.UserID && live.DeviceID == c.session.DeviceID && live.SessionID == c.session.SessionID
}

func (c *Connection) sessionValidated(live grpcauth.Session, now time.Time) {
	deadline := now.Add(sessionAuthorizationWindow)
	if live.ExpiresAt.Before(deadline) {
		deadline = live.ExpiresAt
	}
	c.authorizeUntil(deadline)
}

func (s *Server) checkSessions() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-s.ctx.Done():
			return
		case now := <-ticker.C:
			s.runSessionChecks(s.dueSessionChecks(now), now)
		}
	}
}

func (s *Server) dueSessionChecks(now time.Time) []sessionCheckBatch {
	s.mu.Lock()
	defer s.mu.Unlock()
	var batches []sessionCheckBatch
	batch := sessionCheckBatch{}
	for connection := range s.connections {
		if connection.nextSessionCheck.IsZero() || now.Before(connection.nextSessionCheck) {
			continue
		}
		connection.nextSessionCheck = now.Add(jitteredSessionCheckInterval())
		id := connection.session.SessionID
		if _, ok := batch[id]; !ok && len(batch) == sessionCheckBatchSize {
			batches = append(batches, batch)
			batch = sessionCheckBatch{}
		}
		batch[id] = append(batch[id], connection)
	}
	if len(batch) > 0 {
		batches = append(batches, batch)
	}
	return batches
}

func (s *Server) runSessionChecks(batches []sessionCheckBatch, now time.Time) {
	jobs := make(chan sessionCheckBatch)
	var wg sync.WaitGroup
	for range min(sessionCheckWorkers, len(batches)) {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for batch := range jobs {
				s.checkSessionBatch(batch, now)
			}
		}()
	}
	for _, batch := range batches {
		jobs <- batch
	}
	close(jobs)
	wg.Wait()
}

func (s *Server) checkSessionBatch(batch sessionCheckBatch, now time.Time) {
	ids := make([]string, 0, len(batch))
	for id := range batch {
		ids = append(ids, id)
	}
	ctx, cancel := context.WithTimeout(s.ctx, s.config.APITimeout)
	live, err := s.sessionAuth.ValidateSessions(ctx, ids)
	cancel()
	if err != nil {
		s.logger.Warn("validate WS sessions", "error", err, "sessions", len(ids))
		s.retrySessionChecks(batch, now.Add(sessionCheckRetry))
		return
	}
	for id, connections := range batch {
		session, active := live[id]
		for _, connection := range connections {
			if active && connection.matchesSession(session) {
				s.metrics.SessionChecks.WithLabelValues("active").Inc()
				connection.sessionValidated(session, now)
				continue
			}
			s.metrics.SessionChecks.WithLabelValues("revoked").Inc()
			connection.closeRevoked()
		}
	}
}

func (s *Server) retrySessionChecks(batch sessionCheckBatch, at time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, connections := range batch {
		s.metrics.SessionChecks.WithLabelValues("unavailable").Add(float64(len(connections)))
		for _, connection := range connections {
			connection.nextSessionCheck = at
		}
	}
}
