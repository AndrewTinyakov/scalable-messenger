package socket

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/rabbitmq"
	"messenger/ws/internal/redisroom"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/ticket"
)

var errRateLimited = errors.New("rate limited")
var errRoomLimit = errors.New("room limit")

type roomCoordinator interface {
	Join(context.Context, roomregistry.Recipient, string, string, string, string) error
	LeaveAll(roomregistry.Recipient)
	LeaveChat(roomregistry.Recipient, string, string)
	RunChecks(context.Context)
	Close()
}

type Server struct {
	config           config.Config
	logger           *slog.Logger
	groupAuth        groupAuthorizer
	sessionAuth      sessionAuthorizer
	publisher        *rabbitmq.Publisher
	redis            *redisroom.Client
	handshakeLimiter handshakeLimiter
	connectionLeases connectionLeaser
	subscribeLimiter subscriptionLimiter
	groupAuthSlots   chan struct{}
	rooms            roomCoordinator
	registry         *prometheus.Registry
	metrics          *monitoring.Metrics
	ctx              context.Context
	cancel           context.CancelFunc
	mu               sync.Mutex
	connections      map[*Connection]struct{}
	pendingUpgrades  int
	upgradeWG        sync.WaitGroup
	leaseCleanupCtx  context.Context
	closing          bool
	wg               sync.WaitGroup
}

type groupAuthorizer interface {
	AuthorizeGroup(context.Context, string, string) (string, error)
	AuthorizeGroups(context.Context, string, []string) (map[string]bool, error)
}

type sessionAuthorizer interface {
	ValidateSession(context.Context, string) (grpcauth.Session, error)
}

type connectionLeaser interface {
	AcquireConnectionLease(context.Context, string) (string, bool, error)
	RenewConnectionLease(context.Context, string, string) (bool, error)
	ReleaseConnectionLease(context.Context, string, string) error
}

type handshakeLimiter interface {
	AllowHandshake(context.Context, string, int, time.Duration) (bool, error)
}

type subscriptionLimiter interface {
	AllowSubscribe(context.Context, string, int, time.Duration) (bool, error)
	AllowSubscribeBatch(context.Context, string, int, int, time.Duration) (bool, error)
}

func NewServer(parent context.Context, cfg config.Config, logger *slog.Logger, groupAuth *grpcauth.Client, publisher *rabbitmq.Publisher, redis *redisroom.Client, registry *prometheus.Registry, metrics *monitoring.Metrics) *Server {
	ctx, cancel := context.WithCancel(parent)
	s := &Server{config: cfg, logger: logger, groupAuth: groupAuth, sessionAuth: groupAuth, publisher: publisher, redis: redis, handshakeLimiter: redis, connectionLeases: redis, subscribeLimiter: redis, groupAuthSlots: make(chan struct{}, cfg.MaxGroupAuths), registry: registry, metrics: metrics, ctx: ctx, cancel: cancel, connections: make(map[*Connection]struct{})}
	s.rooms = roomregistry.NewRooms(redis, logger, cfg.ReplayLimit, cfg.QueueItems, cfg.PositionCheckInterval, metrics)
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.rooms.RunChecks(ctx) }()
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok"}`))
	})
	mux.Handle("GET /metrics", promhttp.HandlerFor(s.registry, promhttp.HandlerOpts{}))
	mux.HandleFunc("GET /ws", s.upgrade)
	return mux
}

func (s *Server) upgrade(w http.ResponseWriter, r *http.Request) {
	token := ticketProtocol(r)
	if token == "" || r.URL.RawQuery != "" {
		s.metrics.Handshake.WithLabelValues("invalid_ticket").Inc()
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}
	identity, err := ticket.Verify(token, []byte(s.config.WSTicketSecret), time.Now())
	if err != nil {
		s.metrics.Handshake.WithLabelValues("invalid_ticket").Inc()
		http.Error(w, "invalid WS ticket", http.StatusUnauthorized)
		return
	}
	originAllowed := func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" || s.config.AllowedOrigin == "*" || origin == s.config.AllowedOrigin
	}
	if !originAllowed(r) {
		s.metrics.Handshake.WithLabelValues("invalid_origin").Inc()
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	upgrader := websocket.Upgrader{Subprotocols: []string{"messenger"}, HandshakeTimeout: s.config.WriteTimeout, CheckOrigin: originAllowed}
	if !s.reserveUpgrade() {
		s.metrics.Handshake.WithLabelValues("capacity").Inc()
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
			s.metrics.Handshake.WithLabelValues("handshake_limit_unavailable").Inc()
			http.Error(w, "connection admission unavailable", http.StatusServiceUnavailable)
			return
		}
		if !allowed {
			s.metrics.Handshake.WithLabelValues("handshake_rate_limited").Inc()
			http.Error(w, "too many connection attempts", http.StatusTooManyRequests)
			return
		}
	}
	var leaseID string
	leaseAttached := false
	defer func() {
		if leaseID != "" && !leaseAttached {
			s.releaseConnectionLease(identity.UserID, leaseID)
		}
	}()
	if s.connectionLeases != nil {
		leaseCtx, cancel := context.WithTimeout(r.Context(), s.config.APITimeout)
		stop := context.AfterFunc(s.ctx, cancel)
		var allowed bool
		leaseID, allowed, err = s.connectionLeases.AcquireConnectionLease(leaseCtx, identity.UserID)
		stop()
		cancel()
		if err != nil {
			s.metrics.Handshake.WithLabelValues("lease_unavailable").Inc()
			http.Error(w, "connection admission unavailable", http.StatusServiceUnavailable)
			return
		}
		if !allowed {
			leaseID = ""
			s.metrics.Handshake.WithLabelValues("user_capacity").Inc()
			http.Error(w, "too many connections", http.StatusTooManyRequests)
			return
		}
	}
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		s.metrics.Handshake.WithLabelValues("upgrade_error").Inc()
		return
	}
	c := newConnection(s, ws, identity, token)
	c.connectionLeaseID = leaseID
	leaseAttached = true
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		c.Close()
		return
	}
	s.connections[c] = struct{}{}
	s.metrics.Connections.Inc()
	s.mu.Unlock()
	userRoom := "user:" + identity.UserID
	joinCtx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	err = s.rooms.Join(joinCtx, c, userRoom, "", "", "")
	cancel()
	if err != nil {
		s.metrics.Handshake.WithLabelValues("room_join_failed").Inc()
		s.logger.Error("join user room", "error", err)
		c.Close()
		return
	}
	// Subscribe before querying SQL so a logout racing this connection is
	// either observed as a room event or rejected by ValidateSession.
	validateCtx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	live, err := s.sessionAuth.ValidateSession(validateCtx, token)
	cancel()
	if err != nil {
		if errors.Is(err, grpcauth.ErrUnauthorized) {
			s.metrics.Handshake.WithLabelValues("session_revoked").Inc()
			c.closeRevoked()
		} else {
			s.metrics.Handshake.WithLabelValues("session_unavailable").Inc()
			s.logger.Error("validate WS session", "error", err)
			c.Close()
		}
		return
	}
	if live.UserID != identity.UserID || live.DeviceID != identity.DeviceID || live.SessionID != identity.SessionID {
		s.metrics.Handshake.WithLabelValues("session_mismatch").Inc()
		c.closeRevoked()
		return
	}
	s.mu.Lock()
	s.pendingUpgrades--
	pending = false
	if s.closing || c.ctx.Err() != nil {
		s.mu.Unlock()
		c.Close()
		s.upgradeWG.Done()
		return
	}
	s.wg.Add(1)
	s.wg.Add(1)
	if c.connectionLeaseID != "" {
		s.wg.Add(1)
	}
	s.mu.Unlock()
	s.upgradeWG.Done()
	defer s.wg.Done()
	go func() { defer s.wg.Done(); c.writeLoop() }()
	if c.connectionLeaseID != "" {
		go func() { defer s.wg.Done(); c.renewConnectionLease() }()
	}
	s.metrics.Handshake.WithLabelValues("accepted").Inc()
	c.readLoop()
}

// Reserve before HTTP upgrade so concurrent handshakes count toward capacity.
func (s *Server) reserveUpgrade() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || len(s.connections)+s.pendingUpgrades >= s.config.MaxConnections ||
		(s.config.MaxPendingUpgrades > 0 && s.pendingUpgrades >= s.config.MaxPendingUpgrades) {
		return false
	}
	s.pendingUpgrades++
	s.upgradeWG.Add(1)
	return true
}

func (s *Server) releaseUpgrade() {
	s.mu.Lock()
	s.pendingUpgrades--
	s.mu.Unlock()
	s.upgradeWG.Done()
}

func (s *Server) releaseConnectionLease(userID, leaseID string) {
	if s.connectionLeases == nil || leaseID == "" {
		return
	}
	s.mu.Lock()
	base := s.leaseCleanupCtx
	s.mu.Unlock()
	if base == nil {
		base = context.Background()
	}
	ctx, cancel := context.WithTimeout(base, time.Second)
	defer cancel()
	if err := s.connectionLeases.ReleaseConnectionLease(ctx, userID, leaseID); err != nil && s.logger != nil {
		s.logger.Warn("release connection lease", "error", err)
	}
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

func (s *Server) remove(c *Connection) {
	s.mu.Lock()
	if _, ok := s.connections[c]; ok {
		delete(s.connections, c)
		s.metrics.Connections.Dec()
	}
	s.mu.Unlock()
}

func (s *Server) Close() {
	cleanupTimeout := s.config.ShutdownTimeout
	if cleanupTimeout <= 0 {
		cleanupTimeout = 10 * time.Second
	}
	cleanupCtx, cancel := context.WithTimeout(context.Background(), cleanupTimeout)
	defer cancel()
	s.mu.Lock()
	s.closing = true
	s.leaseCleanupCtx = cleanupCtx
	connections := make([]*Connection, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	// A Redis outage can make each lease release wait for its deadline. Close
	// sockets concurrently with a fixed worker count and one shutdown budget.
	const maxCloseWorkers = 64
	workers := min(len(connections), maxCloseWorkers)
	var closeWG sync.WaitGroup
	jobs := make(chan *Connection)
	for range workers {
		closeWG.Add(1)
		go func() {
			defer closeWG.Done()
			for connection := range jobs {
				connection.Close()
			}
		}()
	}
	for _, connection := range connections {
		jobs <- connection
	}
	close(jobs)
	closeWG.Wait()
	s.cancel()
	s.rooms.Close()
	s.upgradeWG.Wait()
	s.wg.Wait()
}

func (c *Connection) handle(f protocol.Frame) error {
	switch f.Type {
	case "subscribe":
		return c.subscribeOne(protocol.Subscription{ChatID: f.ChatID, Kind: f.Kind, Epoch: f.Epoch, StreamID: f.StreamID})
	case "subscribe_many":
		return c.subscribeMany(f.Subscriptions)
	case "unsubscribe":
		c.leaveChat(f.ChatID)
		return nil
	case "send":
		ctx, cancel := context.WithTimeout(c.ctx, c.server.config.ConfirmTimeout)
		defer cancel()
		allowed, err := c.server.redis.AllowSend(ctx, c.session.UserID)
		if err != nil {
			return fmt.Errorf("rate limit: %w", err)
		}
		if !allowed {
			return errRateLimited
		}
		command := protocol.SendCommand{Version: 1, ChatID: f.ChatID, RecipientID: f.RecipientID, RequestID: f.RequestID, SenderID: c.session.UserID, Body: f.Body, SentAt: time.Now().UTC().Format(time.RFC3339Nano)}
		started := time.Now()
		if err := c.server.publisher.Publish(ctx, command); err != nil {
			c.server.metrics.PublishSeconds.WithLabelValues("failed").Observe(time.Since(started).Seconds())
			code := "publish_failed"
			if errors.Is(err, rabbitmq.ErrUnknownOutcome) {
				code = "publish_unknown"
			}
			c.error(code, f.RequestID)
			return nil
		}
		c.server.metrics.PublishSeconds.WithLabelValues("confirmed").Observe(time.Since(started).Seconds())
		c.Enqueue(protocol.Event{Type: "queued", Version: 1, ChatID: f.ChatID, RecipientID: f.RecipientID, RequestID: f.RequestID})
		return nil
	case "applied":
		err := c.acks.apply(f.ChatID, f.Sequence)
		if err != nil {
			c.server.metrics.Applied.WithLabelValues("rejected").Inc()
			return err
		}
		c.server.metrics.Applied.WithLabelValues("accepted").Inc()
		return nil
	case "dismissed":
		err := c.acks.dismiss(f.ChatID, f.Sequence)
		if err != nil {
			c.server.metrics.Dismissed.WithLabelValues("rejected").Inc()
			return err
		}
		c.server.metrics.Dismissed.WithLabelValues("accepted").Inc()
		return nil
	case "received_message":
		err := c.acks.receivedMessage(f.ChatID, f.Sequence)
		if err != nil {
			c.server.metrics.ReceivedMessages.WithLabelValues("rejected").Inc()
			return err
		}
		c.server.metrics.ReceivedMessages.WithLabelValues("accepted").Inc()
		return nil
	default:
		return errors.New("unknown frame")
	}
}
