package socket

import (
	"context"
	"errors"
	"sync"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

const presenceRefreshInterval = 5 * time.Second
const presenceGrantTTL = 30 * time.Second

type presenceSource interface {
	Presence(context.Context, []string) (map[string]bool, error)
}
type presenceAuthorizer interface {
	AuthorizePresence(context.Context, string, string, []string) ([]string, error)
}
type presenceLimiter interface {
	AllowPresenceWatch(context.Context, string) (bool, error)
}
type connectionEstablisher interface {
	EstablishConnectionLease(context.Context, string, string) (bool, error)
}

type presenceWatch struct {
	chatID     string
	generation uint64
	userIDs    []string
	expires    time.Time
	nextAuth   time.Time
	states     map[string]string
	removed    []string
}

type presenceCoordinator struct {
	server       *Server
	source       presenceSource
	authorizer   presenceAuthorizer
	limiter      presenceLimiter
	mu           sync.Mutex
	watches      map[*Connection]*presenceWatch
	targets      map[string]int
	maxTargets   int
	references   int
	nextSnapshot time.Time
}

func newPresenceCoordinator(s *Server) *presenceCoordinator {
	source, ok := s.connectionLeases.(presenceSource)
	if !ok {
		return nil
	}
	authorizer, ok := s.groupAuth.(presenceAuthorizer)
	if !ok {
		return nil
	}
	limiter, ok := s.handshakeLimiter.(presenceLimiter)
	if !ok {
		return nil
	}
	limit := s.config.MaxMemberships
	if limit <= 0 || limit > 100000 {
		limit = 100000
	}
	return &presenceCoordinator{server: s, source: source, authorizer: authorizer, limiter: limiter, watches: make(map[*Connection]*presenceWatch), targets: make(map[string]int), maxTargets: limit}
}

func (c *Connection) watchPresence(base context.Context, f protocol.Frame) error {
	p := c.server.presence
	if p == nil {
		return errors.New("presence unavailable")
	}
	ctx, cancel := context.WithTimeout(base, c.server.config.APITimeout)
	defer cancel()
	allowed, err := p.limiter.AllowPresenceWatch(ctx, c.session.UserID)
	if err != nil {
		return err
	}
	if !allowed {
		return errRateLimited
	}
	c.mu.Lock()
	generation := c.presenceSerial.Add(1)
	c.presenceChatID = f.ChatID
	c.mu.Unlock()
	started := time.Now()
	peers, err := p.authorize(ctx, c, f.ChatID, f.UserIDs)
	if err != nil {
		c.clearPresence()
		return err
	}
	if len(peers) == 0 {
		c.clearPresence()
		return grpcauth.ErrUnauthorized
	}
	watch := &presenceWatch{generation: generation, chatID: f.ChatID, userIDs: peers, expires: started.Add(presenceGrantTTL), nextAuth: started.Add(20*time.Second + jitteredFirstTick(5*time.Second)), states: make(map[string]string)}
	return p.install(c, watch)
}

func (p *presenceCoordinator) authorize(ctx context.Context, c *Connection, chatID string, peers []string) ([]string, error) {
	started := time.Now()
	result := "failed"
	defer func() {
		p.server.metrics.PresenceAuthorization.WithLabelValues(result).Observe(time.Since(started).Seconds())
	}()
	select {
	case p.server.groupAuthSlots <- struct{}{}:
		defer func() { <-p.server.groupAuthSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	allowed, err := p.authorizer.AuthorizePresence(ctx, c.session.SessionID, chatID, peers)
	if err != nil {
		if errors.Is(err, grpcauth.ErrUnauthorized) {
			result = "denied"
		}
		return nil, err
	}
	requested := make(map[string]bool, len(peers))
	for _, id := range peers {
		requested[id] = true
	}
	seen := make(map[string]bool, len(allowed))
	for _, id := range allowed {
		if !requested[id] || seen[id] {
			return nil, errors.New("invalid presence authorization")
		}
		seen[id] = true
	}
	result = "authorized"
	return allowed, nil
}

func (p *presenceCoordinator) install(c *Connection, watch *presenceWatch) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if c.ctx.Err() != nil {
		return c.ctx.Err()
	}
	if watch.generation != c.presenceSerial.Load() {
		return grpcauth.ErrUnauthorized
	}
	unique := len(p.targets)
	incoming := make(map[string]bool, len(watch.userIDs))
	for _, id := range watch.userIDs {
		incoming[id] = true
		if p.targets[id] == 0 {
			unique++
		}
	}
	if old := p.watches[c]; old != nil {
		for _, id := range old.userIDs {
			if p.targets[id] == 1 && !incoming[id] {
				unique--
			}
		}
	}
	if unique > p.maxTargets {
		return errRoomLimit
	}
	p.removeLocked(c)
	p.watches[c] = watch
	p.references += len(watch.userIDs)
	for _, id := range watch.userIDs {
		p.targets[id]++
	}
	p.nextSnapshot = time.Time{}
	p.updateMetricsLocked()
	return nil
}

func (c *Connection) clearPresence() {
	c.mu.Lock()
	c.presenceSerial.Add(1)
	c.presenceChatID = ""
	c.mu.Unlock()
	if p := c.server.presence; p != nil {
		p.mu.Lock()
		p.removeLocked(c)
		p.updateMetricsLocked()
		p.mu.Unlock()
	}
}

func (c *Connection) clearChatPresence(chatID string) {
	c.mu.Lock()
	if c.presenceChatID == chatID {
		c.presenceSerial.Add(1)
		c.presenceChatID = ""
	}
	c.mu.Unlock()
	if p := c.server.presence; p != nil {
		p.mu.Lock()
		if watch := p.watches[c]; watch != nil && watch.chatID == chatID {
			p.removeLocked(c)
			p.updateMetricsLocked()
		}
		p.mu.Unlock()
	}
}

func (p *presenceCoordinator) removeLocked(c *Connection) {
	if old := p.watches[c]; old != nil {
		delete(p.watches, c)
		p.references -= len(old.userIDs)
		for _, id := range old.userIDs {
			p.targets[id]--
			if p.targets[id] == 0 {
				delete(p.targets, id)
			}
		}
	}
}

func (p *presenceCoordinator) current(c *Connection, watch *presenceWatch) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.watches[c] == watch && watch.generation == c.presenceSerial.Load() && time.Now().Before(watch.expires)
}

func (p *presenceCoordinator) updateMetricsLocked() {
	p.server.metrics.PresenceReferences.Set(float64(p.references))
	p.server.metrics.PresenceWatches.Set(float64(len(p.watches)))
	p.server.metrics.PresenceTargets.Set(float64(len(p.targets)))
}
