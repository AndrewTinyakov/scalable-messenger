package socket

import (
	"context"
	"fmt"
	"log/slog"
	"reflect"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/presence"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
)

type RoomCoordinator interface {
	Join(context.Context, roomregistry.Recipient, string, string, string, string) error
	LeaveAll(roomregistry.Recipient)
	LeaveChat(roomregistry.Recipient, string, string)
	RunChecks(context.Context)
	Close()
}

type Server struct {
	config           config.Config
	logger           *slog.Logger
	groupAuth        GroupAuthorizer
	sessionAuth      SessionAuthorizer
	publisher        CommandPublisher
	sendLimiter      SendLimiter
	handshakeLimiter HandshakeLimiter
	admission        ConnectionAdmission
	tracker          PresenceTracker
	watchers         PresenceWatchers
	watchLimiter     WatchLimiter
	sidebarActivity  sidebarActivitySource
	subscribeLimiter SubscriptionLimiter
	groupAuthSlots   chan struct{}
	rooms            RoomCoordinator
	registry         *prometheus.Registry
	metrics          *monitoring.Metrics
	ctx              context.Context
	cancel           context.CancelFunc
	mu               sync.Mutex
	connections      map[*Connection]struct{}
	pendingUpgrades  int
	upgradeWG        sync.WaitGroup
	state            serverState
	wg               sync.WaitGroup
	writeBuffers     sync.Pool
	runtimeOnce      sync.Once
	closeOnce        sync.Once
	commands         *commandQueue
	sidebar          *sidebarCoordinator
}

type CommandPublisher interface {
	Publish(context.Context, protocol.SendCommand) error
}

type SendLimiter interface {
	AllowSend(context.Context, string) (bool, error)
}

type GroupAuthorizer interface {
	AuthorizeGroup(context.Context, string, string) (string, error)
	AuthorizeGroups(context.Context, string, []string) (map[string]bool, error)
}

type SessionAuthorizer interface {
	ValidateSession(context.Context, string) (grpcauth.Session, error)
	ValidateSessions(context.Context, []string) (map[string]grpcauth.Session, error)
}

type ConnectionAdmission interface {
	Admit(context.Context, string) (bool, error)
	Release(string)
}

type PresenceTracker interface {
	SetActive(string, bool)
}

type PresenceWatchers interface {
	Watch(context.Context, presence.Watcher, []string, []string, bool) error
	WatchOnlineCount(context.Context, presence.Watcher, string) error
	SetVisible(presence.Watcher, bool)
	Revalidate(presence.Watcher)
	Remove(presence.Watcher)
}

type WatchLimiter interface {
	AllowPresenceWatch(context.Context, string) (bool, error)
}

type HandshakeLimiter interface {
	AllowHandshake(context.Context, string, int, time.Duration) (bool, error)
}

type SubscriptionLimiter interface {
	AllowSubscribe(context.Context, string, int, time.Duration) (bool, error)
	AllowSubscribeBatch(context.Context, string, int, int, time.Duration) (bool, error)
}

type Dependencies struct {
	GroupAuthorizer   GroupAuthorizer
	SessionAuthorizer SessionAuthorizer
	Publisher         CommandPublisher
	SendLimiter       SendLimiter
	HandshakeLimiter  HandshakeLimiter
	Admission         ConnectionAdmission
	Presence          PresenceTracker
	Watchers          PresenceWatchers
	WatchLimiter      WatchLimiter
	SidebarActivity   interface {
		RunActivity(context.Context, string, func(protocol.Event)) error
	}
	SubscriptionLimiter SubscriptionLimiter
	Rooms               RoomCoordinator
}

func NewServer(parent context.Context, cfg config.Config, logger *slog.Logger, dependencies Dependencies, registry *prometheus.Registry, metrics *monitoring.Metrics) (*Server, error) {
	for _, dependency := range []struct {
		name  string
		value any
	}{
		{"context", parent}, {"logger", logger}, {"registry", registry}, {"metrics", metrics},
		{"group authorizer", dependencies.GroupAuthorizer}, {"session authorizer", dependencies.SessionAuthorizer},
		{"publisher", dependencies.Publisher}, {"send limiter", dependencies.SendLimiter},
		{"handshake limiter", dependencies.HandshakeLimiter}, {"connection admission", dependencies.Admission},
		{"presence tracker", dependencies.Presence}, {"presence watchers", dependencies.Watchers}, {"watch limiter", dependencies.WatchLimiter},
		{"sidebar activity", dependencies.SidebarActivity},
		{"subscription limiter", dependencies.SubscriptionLimiter}, {"rooms", dependencies.Rooms},
	} {
		if nilDependency(dependency.value) {
			return nil, fmt.Errorf("missing %s", dependency.name)
		}
	}
	if cfg.MaxGroupAuths <= 0 || cfg.QueueItems <= 0 || cfg.QueueBytes <= 0 {
		return nil, fmt.Errorf("group authorization and outbound queue limits must be positive")
	}
	ctx, cancel := context.WithCancel(parent)
	s := &Server{
		config:           cfg,
		logger:           logger,
		groupAuth:        dependencies.GroupAuthorizer,
		sessionAuth:      dependencies.SessionAuthorizer,
		publisher:        dependencies.Publisher,
		sendLimiter:      dependencies.SendLimiter,
		handshakeLimiter: dependencies.HandshakeLimiter,
		admission:        dependencies.Admission,
		tracker:          dependencies.Presence,
		watchers:         dependencies.Watchers,
		watchLimiter:     dependencies.WatchLimiter,
		sidebarActivity:  dependencies.SidebarActivity,
		subscribeLimiter: dependencies.SubscriptionLimiter,
		rooms:            dependencies.Rooms,
		groupAuthSlots:   make(chan struct{}, cfg.MaxGroupAuths),
		registry:         registry,
		metrics:          metrics,
		ctx:              ctx,
		cancel:           cancel,
		connections:      make(map[*Connection]struct{}),
	}
	s.metrics.SetCapacity(monitoring.CapacityResource("pending_upgrades"), cfg.MaxPendingUpgrades)
	registry.MustRegister(prometheus.NewGaugeFunc(prometheus.GaugeOpts{Name: "messenger_ws_oldest_pending_ack_seconds", Help: "Age of the oldest still-pending live acknowledgement on this node."}, s.oldestPendingACK))
	s.sidebar = newSidebarCoordinator(s)
	s.startRuntime()
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.rooms.RunChecks(ctx) }()
	return s, nil
}

func nilDependency(value any) bool {
	if value == nil {
		return true
	}
	reflected := reflect.ValueOf(value)
	switch reflected.Kind() {
	case reflect.Chan, reflect.Func, reflect.Interface, reflect.Map, reflect.Pointer, reflect.Slice:
		return reflected.IsNil()
	default:
		return false
	}
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
	s.CloseContext(context.Background())
}

func (s *Server) CloseContext(ctx context.Context) {
	s.closeOnce.Do(func() { s.close(ctx) })
}

func (s *Server) close(context.Context) {
	s.mu.Lock()
	s.state = serverClosing
	connections := make([]*Connection, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
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

func (s *Server) oldestPendingACK() float64 {
	s.mu.Lock()
	connections := make([]*Connection, 0, len(s.connections))
	for c := range s.connections {
		connections = append(connections, c)
	}
	s.mu.Unlock()
	oldest := 0.0
	now := time.Now()
	for _, c := range connections {
		deadline := c.acks.nextDeadline()
		if !deadline.IsZero() {
			oldest = max(oldest, now.Sub(deadline.Add(-c.acks.deadline)).Seconds())
		}
	}
	return oldest
}
