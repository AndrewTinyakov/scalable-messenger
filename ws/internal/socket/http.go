package socket

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus/promhttp"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/roomname"
	"messenger/ws/internal/ticket"
)

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.HandleFunc("GET /readyz", s.ready)
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /ws", s.upgrade)
	return mux
}

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request) {
	setup := s.metrics.BeginHandshake()
	defer setup.Finish(monitoring.HandshakeSetupCanceled)
	recordHandshake := func(outcome monitoring.HandshakeOutcome) {
		setup.Finish(outcome)
		s.metrics.RecordHandshake(outcome)
	}
	token := ticketProtocol(r)
	if token == "" || r.URL.RawQuery != "" {
		recordHandshake(monitoring.HandshakeInvalidTicket)
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}
	identity, err := ticket.Verify(token, []byte(s.config.WSTicketSecret), time.Now())
	if err != nil {
		recordHandshake(monitoring.HandshakeInvalidTicket)
		http.Error(w, "invalid WS ticket", http.StatusUnauthorized)
		return
	}
	originAllowed := func(r *http.Request) bool {
		origins, present := r.Header["Origin"]
		return !present || (len(origins) == 1 && origins[0] == s.config.AllowedOrigin)
	}
	if !originAllowed(r) {
		recordHandshake(monitoring.HandshakeInvalidOrigin)
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	upgrader := websocket.Upgrader{WriteBufferPool: &s.writeBuffers, Subprotocols: []string{"messenger"}, HandshakeTimeout: s.config.WriteTimeout, CheckOrigin: originAllowed}
	if !s.reserveUpgrade() {
		recordHandshake(monitoring.HandshakeCapacity)
		http.Error(w, "capacity reached", http.StatusServiceUnavailable)
		return
	}
	pending := true
	defer func() {
		if pending {
			s.releaseUpgrade()
		}
	}()
	if s.handshakeLimiter != nil {
		limitCtx, cancel := context.WithTimeout(r.Context(), s.config.APITimeout)
		stop := context.AfterFunc(s.ctx, cancel)
		allowed, err := s.handshakeLimiter.AllowHandshake(limitCtx, identity.UserID, s.config.HandshakeRate, s.config.HandshakeWindow)
		stop()
		cancel()
		if err != nil {
			recordHandshake(monitoring.HandshakeLimitUnavailable)
			http.Error(w, "connection admission unavailable", http.StatusServiceUnavailable)
			return
		}
		if !allowed {
			recordHandshake(monitoring.HandshakeRateLimited)
			http.Error(w, "too many connection attempts", http.StatusTooManyRequests)
			return
		}
	}
	setup.CompleteStage()
	var leaseID string
	leaseAttached := false
	defer func() {
		if leaseID != "" && !leaseAttached {
			s.releaseConnectionLease(identity.UserID, leaseID)
		}
	}()
	if s.connectionLeases != nil {
		setup.NextStage(monitoring.HandshakeConnectionLease)
		leaseCtx, cancel := context.WithTimeout(r.Context(), s.config.APITimeout)
		stop := context.AfterFunc(s.ctx, cancel)
		var allowed bool
		leaseID, allowed, err = s.connectionLeases.AcquireConnectionLease(leaseCtx, identity.UserID)
		stop()
		cancel()
		if err != nil {
			recordHandshake(monitoring.HandshakeLeaseUnavailable)
			http.Error(w, "connection admission unavailable", http.StatusServiceUnavailable)
			return
		}
		if !allowed {
			leaseID = ""
			recordHandshake(monitoring.HandshakeUserCapacity)
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
	}
	setup.NextStage(monitoring.HandshakeHTTPUpgrade)
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		recordHandshake(monitoring.HandshakeUpgradeError)
		return
	}
	setup.CompleteStage()
	c := newConnection(s, ws, identity, leaseID)
	leaseAttached = true
	s.mu.Lock()
	c.mu.Lock()
	if s.closing || s.draining || c.closed {
		c.mu.Unlock()
		s.mu.Unlock()
		c.Close()
		return
	}
	s.connections[c] = struct{}{}
	s.metrics.Connections.Inc()
	c.mu.Unlock()
	s.mu.Unlock()
	setup.NextStage(monitoring.HandshakeUserRoomJoin)
	userRoom := roomname.User(identity.UserID)
	joinCtx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	err = s.rooms.Join(joinCtx, c, userRoom, "", "", "")
	cancel()
	if err != nil {
		recordHandshake(monitoring.HandshakeRoomJoinFailed)
		s.logger.Error("join user room", "error", err)
		c.Close()
		return
	}
	// Subscribe before querying SQL so a logout racing this connection is
	// either observed as a room event or rejected by ValidateSession.
	setup.NextStage(monitoring.HandshakeSessionValidation)
	validateCtx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	live, err := s.sessionAuth.ValidateSession(validateCtx, identity.SessionID)
	cancel()
	if err != nil {
		if errors.Is(err, grpcauth.ErrUnauthorized) {
			recordHandshake(monitoring.HandshakeSessionRevoked)
			c.closeRevoked()
		} else {
			recordHandshake(monitoring.HandshakeSessionUnavailable)
			s.logger.Error("validate WS session", "error", err)
			c.Close()
		}
		return
	}
	if live.UserID != identity.UserID || live.DeviceID != identity.DeviceID || live.SessionID != identity.SessionID {
		recordHandshake(monitoring.HandshakeSessionMismatch)
		c.closeRevoked()
		return
	}
	if promoter, ok := s.connectionLeases.(connectionEstablisher); ok {
		setup.NextStage(monitoring.HandshakePresenceEstablish)
		ctx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
		established, err := promoter.EstablishConnectionLease(ctx, identity.UserID, leaseID)
		cancel()
		if err != nil || !established {
			recordHandshake(monitoring.HandshakeLeaseUnavailable)
			c.Close()
			return
		}
	}
	setup.CompleteStage()
	s.mu.Lock()
	s.pendingUpgrades--
	s.metrics.PendingUpgrades.Dec()
	pending = false
	if s.closing || s.draining || c.ctx.Err() != nil {
		s.mu.Unlock()
		c.Close()
		s.upgradeWG.Done()
		return
	}
	s.wg.Add(1)
	s.wg.Add(1)
	s.mu.Unlock()
	s.upgradeWG.Done()
	defer s.wg.Done()
	recordHandshake(monitoring.HandshakeAccepted)
	go func() { defer s.wg.Done(); c.writeLoop() }()
	c.readLoop()
}

// Reserve before HTTP upgrade so concurrent handshakes count toward capacity.
func (s *Server) reserveUpgrade() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.draining || len(s.connections)+s.pendingUpgrades >= s.config.MaxConnections ||
		(s.config.MaxPendingUpgrades > 0 && s.pendingUpgrades >= s.config.MaxPendingUpgrades) {
		return false
	}
	s.pendingUpgrades++
	s.metrics.PendingUpgrades.Inc()
	s.upgradeWG.Add(1)
	return true
}

func (s *Server) releaseUpgrade() {
	s.mu.Lock()
	s.pendingUpgrades--
	s.metrics.PendingUpgrades.Dec()
	s.mu.Unlock()
	s.upgradeWG.Done()
}

func ticketProtocol(r *http.Request) string {
	var token string
	seenMessenger := false
	for _, protocol := range websocket.Subprotocols(r) {
		if protocol == "messenger" {
			seenMessenger = true
			continue
		}
		if strings.HasPrefix(protocol, "messenger-ticket.") {
			if token != "" {
				return ""
			}
			token = strings.TrimPrefix(protocol, "messenger-ticket.")
		}
	}
	if !seenMessenger || token == "" || len(token) > 4096 {
		return ""
	}
	return token
}
