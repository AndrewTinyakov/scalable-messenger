package socket

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/roomname"
	"messenger/ws/internal/ticket"
)

const (
	messengerSubprotocol = "messenger"
	ticketSubprotocol    = "messenger-ticket."
	maxTicketBytes       = 4096
)

type handshake struct {
	server        *Server
	setup         monitoring.HandshakeSetup
	identity      ticket.Identity
	leaseID       string
	leaseAttached bool
	reserved      bool
}

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request) {
	h := &handshake{server: s, setup: s.metrics.BeginHandshake()}
	defer h.setup.Finish(monitoring.HandshakeSetupCanceled)
	if !h.authenticate(w, r) {
		return
	}
	if !s.reserveUpgrade() {
		h.reject(w, monitoring.HandshakeCapacity, http.StatusServiceUnavailable, "capacity reached")
		return
	}
	h.reserved = true
	defer h.release()
	if !h.admit(w, r) {
		return
	}
	h.setup.NextStage(monitoring.HandshakeHTTPUpgrade)
	upgrader := websocket.Upgrader{
		WriteBufferPool:  &s.writeBuffers,
		Subprotocols:     []string{messengerSubprotocol},
		HandshakeTimeout: s.config.WriteTimeout,
		CheckOrigin:      s.originAllowed,
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.record(monitoring.HandshakeUpgradeError)
		return
	}
	h.setup.CompleteStage()
	c := newConnection(s, ws, h.identity, h.leaseID)
	h.leaseAttached = true
	if !s.register(c) {
		c.Close()
		return
	}
	if !h.establish(c) {
		return
	}
	h.setup.CompleteStage()
	if !h.activate(c) {
		return
	}
	defer s.wg.Done()
	h.record(monitoring.HandshakeAccepted)
	go func() { defer s.wg.Done(); c.writeLoop() }()
	c.readLoop()
}

func (h *handshake) record(outcome monitoring.HandshakeOutcome) {
	h.setup.Finish(outcome)
	h.server.metrics.RecordHandshake(outcome)
}

func (h *handshake) reject(w http.ResponseWriter, outcome monitoring.HandshakeOutcome, status int, message string) {
	h.record(outcome)
	http.Error(w, message, status)
}

func (h *handshake) authenticate(w http.ResponseWriter, r *http.Request) bool {
	s := h.server
	token := ticketProtocol(r)
	if token == "" || r.URL.RawQuery != "" {
		h.reject(w, monitoring.HandshakeInvalidTicket, http.StatusUnauthorized, "missing token")
		return false
	}
	identity, err := ticket.Verify(token, []byte(s.config.WSTicketSecret), time.Now())
	if err != nil {
		h.reject(w, monitoring.HandshakeInvalidTicket, http.StatusUnauthorized, "invalid WS ticket")
		return false
	}
	if !s.originAllowed(r) {
		h.reject(w, monitoring.HandshakeInvalidOrigin, http.StatusForbidden, "origin not allowed")
		return false
	}
	h.identity = identity
	return true
}

func (h *handshake) admit(w http.ResponseWriter, r *http.Request) bool {
	s := h.server
	if s.handshakeLimiter != nil {
		ctx, cancel := s.admissionContext(r.Context())
		allowed, err := s.handshakeLimiter.AllowHandshake(ctx, h.identity.UserID, s.config.HandshakeRate, s.config.HandshakeWindow)
		cancel()
		if err != nil {
			h.reject(w, monitoring.HandshakeLimitUnavailable, http.StatusServiceUnavailable, "connection admission unavailable")
			return false
		}
		if !allowed {
			h.reject(w, monitoring.HandshakeRateLimited, http.StatusTooManyRequests, "too many connection attempts")
			return false
		}
	}
	h.setup.CompleteStage()
	if s.connectionLeases == nil {
		return true
	}
	h.setup.NextStage(monitoring.HandshakeConnectionLease)
	ctx, cancel := s.admissionContext(r.Context())
	leaseID, allowed, err := s.connectionLeases.AcquireConnectionLease(ctx, h.identity.UserID)
	cancel()
	h.leaseID = leaseID
	if err != nil {
		h.reject(w, monitoring.HandshakeLeaseUnavailable, http.StatusServiceUnavailable, "connection admission unavailable")
		return false
	}
	if !allowed {
		h.leaseID = ""
		h.reject(w, monitoring.HandshakeUserCapacity, http.StatusTooManyRequests, "too many connections")
		return false
	}
	return true
}

func (h *handshake) establish(c *Connection) bool {
	s := h.server
	h.setup.NextStage(monitoring.HandshakeUserRoomJoin)
	ctx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	err := s.rooms.Join(ctx, c, roomname.User(h.identity.UserID), "", "", "")
	cancel()
	if err != nil {
		h.record(monitoring.HandshakeRoomJoinFailed)
		s.logger.Error("join user room", "error", err)
		c.Close()
		return false
	}
	// Subscribe before querying SQL so a logout racing this connection is
	// either observed as a room event or rejected by ValidateSession.
	if !h.validateSession(c) {
		return false
	}
	return h.promoteLease(c)
}

func (h *handshake) validateSession(c *Connection) bool {
	s := h.server
	h.setup.NextStage(monitoring.HandshakeSessionValidation)
	ctx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	live, err := s.sessionAuth.ValidateSession(ctx, h.identity.SessionID)
	cancel()
	if errors.Is(err, grpcauth.ErrUnauthorized) {
		h.record(monitoring.HandshakeSessionRevoked)
		c.closeRevoked()
		return false
	}
	if err != nil {
		h.record(monitoring.HandshakeSessionUnavailable)
		s.logger.Error("validate WS session", "error", err)
		c.Close()
		return false
	}
	if live.UserID != h.identity.UserID || live.DeviceID != h.identity.DeviceID || live.SessionID != h.identity.SessionID {
		h.record(monitoring.HandshakeSessionMismatch)
		c.closeRevoked()
		return false
	}
	return true
}

func (h *handshake) promoteLease(c *Connection) bool {
	s := h.server
	promoter, ok := s.connectionLeases.(connectionEstablisher)
	if !ok {
		return true
	}
	h.setup.NextStage(monitoring.HandshakePresenceEstablish)
	ctx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	established, err := promoter.EstablishConnectionLease(ctx, h.identity.UserID, h.leaseID)
	cancel()
	if err != nil || !established {
		h.record(monitoring.HandshakeLeaseUnavailable)
		c.Close()
		return false
	}
	return true
}

func (h *handshake) activate(c *Connection) bool {
	s := h.server
	s.mu.Lock()
	s.pendingUpgrades--
	s.metrics.PendingUpgrades.Dec()
	h.reserved = false
	if s.closing || s.draining || c.ctx.Err() != nil {
		s.mu.Unlock()
		c.Close()
		s.upgradeWG.Done()
		return false
	}
	s.wg.Add(2)
	s.mu.Unlock()
	s.upgradeWG.Done()
	return true
}

func (h *handshake) release() {
	if h.leaseID != "" && !h.leaseAttached {
		h.server.releaseConnectionLease(h.identity.UserID, h.leaseID)
	}
	if h.reserved {
		h.server.releaseUpgrade()
	}
}

func (s *Server) originAllowed(r *http.Request) bool {
	origins, present := r.Header["Origin"]
	return !present || (len(origins) == 1 && origins[0] == s.config.AllowedOrigin)
}

func (s *Server) admissionContext(parent context.Context) (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithTimeout(parent, s.config.APITimeout)
	stop := context.AfterFunc(s.ctx, cancel)
	return ctx, func() {
		stop()
		cancel()
	}
}

func (s *Server) register(c *Connection) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	c.mu.Lock()
	defer c.mu.Unlock()
	if s.closing || s.draining || c.closed {
		return false
	}
	s.connections[c] = struct{}{}
	s.metrics.Connections.Inc()
	return true
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
		if protocol == messengerSubprotocol {
			seenMessenger = true
			continue
		}
		if strings.HasPrefix(protocol, ticketSubprotocol) {
			if token != "" {
				return ""
			}
			token = strings.TrimPrefix(protocol, ticketSubprotocol)
		}
	}
	if !seenMessenger || token == "" || len(token) > maxTicketBytes {
		return ""
	}
	return token
}
