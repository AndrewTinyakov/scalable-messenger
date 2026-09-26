package socket

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promhttp"
	"messenger/ws/internal/apiclient"
	"messenger/ws/internal/config"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/rabbitmq"
	"messenger/ws/internal/redisroom"
	roomregistry "messenger/ws/internal/room"
)

var errRateLimited = errors.New("rate limited")
var errRoomLimit = errors.New("room limit")

type roomCoordinator interface {
	Join(context.Context, roomregistry.Recipient, string, string, string, string) error
	LeaveAll(roomregistry.Recipient)
	LeaveConversation(roomregistry.Recipient, string, string)
	RunChecks(context.Context)
	Close()
}

type Server struct {
	config      config.Config
	logger      *slog.Logger
	api         *apiclient.Client
	publisher   *rabbitmq.Publisher
	redis       *redisroom.Client
	rooms       roomCoordinator
	registry    *prometheus.Registry
	metrics     *monitoring.Metrics
	ctx         context.Context
	cancel      context.CancelFunc
	mu          sync.Mutex
	connections map[*Connection]struct{}
	closing     bool
	wg          sync.WaitGroup
}

func NewServer(parent context.Context, cfg config.Config, logger *slog.Logger, api *apiclient.Client, publisher *rabbitmq.Publisher, redis *redisroom.Client, registry *prometheus.Registry, metrics *monitoring.Metrics) *Server {
	ctx, cancel := context.WithCancel(parent)
	s := &Server{config: cfg, logger: logger, api: api, publisher: publisher, redis: redis, registry: registry, metrics: metrics, ctx: ctx, cancel: cancel, connections: make(map[*Connection]struct{})}
	s.rooms = roomregistry.NewRooms(redis, logger, cfg.ReplayLimit, cfg.QueueItems, cfg.PositionCheckInterval, metrics)
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.rooms.RunChecks(ctx) }()
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.runReauthorization(ctx) }()
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
	token := r.URL.Query().Get("token")
	if token == "" || len(token) > 4096 {
		http.Error(w, "missing token", http.StatusUnauthorized)
		return
	}
	session, err := s.api.Session(r.Context(), token)
	if err != nil {
		status := http.StatusServiceUnavailable
		if errors.Is(err, apiclient.ErrUnauthorized) {
			status = http.StatusUnauthorized
		}
		http.Error(w, "session unavailable", status)
		return
	}
	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		return origin == "" || s.config.AllowedOrigin == "*" || origin == s.config.AllowedOrigin
	}}
	s.mu.Lock()
	if s.closing || len(s.connections) >= s.config.MaxConnections {
		s.mu.Unlock()
		http.Error(w, "capacity reached", http.StatusServiceUnavailable)
		return
	}
	s.mu.Unlock()
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	c := newConnection(s, ws, session, token)
	s.mu.Lock()
	if s.closing {
		s.mu.Unlock()
		c.Close()
		return
	}
	s.connections[c] = struct{}{}
	s.metrics.Connections.Inc()
	s.wg.Add(1)
	s.mu.Unlock()
	go func() { defer s.wg.Done(); c.writeLoop() }()
	userRoom := "user:" + session.UserID
	joinCtx, cancel := context.WithTimeout(c.ctx, s.config.APITimeout)
	err = s.rooms.Join(joinCtx, c, userRoom, "", "", "")
	cancel()
	if err != nil {
		s.logger.Error("join user room", "error", err)
		c.Close()
		return
	}
	c.readLoop()
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
	s.mu.Lock()
	s.closing = true
	connections := make([]*Connection, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	for _, c := range connections {
		c.Close()
	}
	s.cancel()
	s.rooms.Close()
	s.wg.Wait()
}

func (s *Server) runReauthorization(ctx context.Context) {
	ticker := time.NewTicker(s.config.ReauthorizeInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			s.reauthorizeAll(ctx)
		}
	}
}

func (s *Server) reauthorizeAll(ctx context.Context) {
	s.mu.Lock()
	connections := make([]*Connection, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	capacity := make(chan struct{}, 16)
	var work sync.WaitGroup
	for _, c := range connections {
		select {
		case capacity <- struct{}{}:
		case <-ctx.Done():
			work.Wait()
			return
		}
		work.Add(1)
		go func(c *Connection) { defer work.Done(); defer func() { <-capacity }(); s.reauthorize(ctx, c) }(c)
	}
	work.Wait()
}

func (s *Server) reauthorize(ctx context.Context, c *Connection) {
	request, cancel := context.WithTimeout(ctx, s.config.APITimeout)
	session, err := s.api.Session(request, c.token)
	cancel()
	if errors.Is(err, apiclient.ErrUnauthorized) || err == nil && session.UserID != c.session.UserID {
		c.Close()
		return
	}
	if err != nil {
		return
	}
	c.mu.Lock()
	rooms := make(map[string]string, len(c.rooms))
	for id, room := range c.rooms {
		rooms[id] = room
	}
	c.mu.Unlock()
	for id, oldRoom := range rooms {
		request, cancel := context.WithTimeout(ctx, s.config.APITimeout)
		auth, err := s.api.Authorize(request, c.token, id)
		cancel()
		if errors.Is(err, apiclient.ErrUnauthorized) || err == nil && auth.Room != oldRoom {
			c.removeRoom(id)
			s.rooms.LeaveConversation(c, oldRoom, id)
			c.Enqueue(protocol.Event{Type: "recovery_failed", Version: 1, ConversationID: id, Room: oldRoom})
		}
	}
}

func (c *Connection) handle(f protocol.Frame) error {
	switch f.Type {
	case "subscribe":
		if c.room(f.ConversationID) != "" {
			return nil
		}
		if c.roomCount() >= c.server.config.MaxRoomsPerConnection {
			return errRoomLimit
		}
		ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
		defer cancel()
		auth, err := c.server.api.Authorize(ctx, c.token, f.ConversationID)
		if err != nil {
			return err
		}
		if err := c.server.rooms.Join(ctx, c, auth.Room, f.ConversationID, f.Epoch, f.StreamID); err != nil {
			return err
		}
		c.setRoom(f.ConversationID, auth.Room)
		return nil
	case "send":
		ctx, cancel := context.WithTimeout(c.ctx, c.server.config.ConfirmTimeout+c.server.config.APITimeout)
		defer cancel()
		if _, err := c.server.api.Authorize(ctx, c.token, f.ConversationID); err != nil {
			return err
		}
		allowed, err := c.server.redis.AllowSend(ctx, c.session.UserID)
		if err != nil {
			return fmt.Errorf("rate limit: %w", err)
		}
		if !allowed {
			return errRateLimited
		}
		command := protocol.SendCommand{Version: 1, ConversationID: f.ConversationID, RequestID: f.RequestID, SenderID: c.session.UserID, Body: f.Body, SentAt: time.Now().UTC().Format(time.RFC3339Nano)}
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
		c.Enqueue(protocol.Event{Type: "queued", Version: 1, ConversationID: f.ConversationID, RequestID: f.RequestID})
		return nil
	case "applied":
		return c.acks.apply(f.ConversationID, f.Sequence)
	default:
		return errors.New("unknown frame")
	}
}
