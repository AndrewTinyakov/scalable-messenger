package socket

import (
	"context"
	"errors"
	"sync"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

type sidebarAuthorizer interface {
	AuthorizeSidebar(context.Context, string, []string) ([]grpcauth.SidebarChat, error)
}
type sidebarActivitySource interface {
	RunActivity(context.Context, string, func(protocol.Event)) error
}
type sidebarWatch struct {
	generation uint64
	chatIDs    []string
	groups     map[string]bool
	expires    time.Time
	nextAuth   time.Time
}
type sidebarFeed struct {
	cancel   context.CancelFunc
	watchers map[*Connection]*sidebarWatch
}
type sidebarCoordinator struct {
	server     *Server
	authorizer sidebarAuthorizer
	source     sidebarActivitySource
	mu         sync.Mutex
	watches    map[*Connection]*sidebarWatch
	feeds      map[string]*sidebarFeed
	references int
	state      lifecycleState
	wg         sync.WaitGroup
}

func newSidebarCoordinator(s *Server) *sidebarCoordinator {
	auth, ok := s.groupAuth.(sidebarAuthorizer)
	if !ok {
		return nil
	}
	return &sidebarCoordinator{server: s, authorizer: auth, source: s.sidebarActivity, watches: make(map[*Connection]*sidebarWatch), feeds: make(map[string]*sidebarFeed)}
}

func (c *Connection) watchSidebar(base context.Context, ids []string) error {
	p := c.server.sidebar
	if p == nil {
		return errors.New("sidebar unavailable")
	}
	ctx, cancel := context.WithTimeout(base, c.server.config.APITimeout)
	defer cancel()
	if err := c.allowWatch(ctx); err != nil {
		return err
	}
	generation := c.sidebarSerial.Add(1)
	if len(ids) == 0 {
		p.remove(c)
		return nil
	}
	watch, err := p.authorize(ctx, c, ids, generation)
	if err != nil {
		p.remove(c)
		return err
	}
	return p.install(c, nil, watch)
}

func (p *sidebarCoordinator) authorize(ctx context.Context, c *Connection, ids []string, generation uint64) (*sidebarWatch, error) {
	select {
	case p.server.groupAuthSlots <- struct{}{}:
		defer func() { <-p.server.groupAuthSlots }()
	case <-ctx.Done():
		return nil, ctx.Err()
	}
	started := time.Now()
	chats, err := p.authorizer.AuthorizeSidebar(ctx, c.session.SessionID, ids)
	if err != nil {
		return nil, err
	}
	watch := &sidebarWatch{generation: generation, chatIDs: append([]string(nil), ids...), groups: make(map[string]bool), expires: started.Add(30 * time.Second), nextAuth: started.Add(20*time.Second + jitteredFirstTick(5*time.Second))}
	requested := make(map[string]bool, len(ids))
	for _, id := range ids {
		requested[id] = true
	}
	for _, chat := range chats {
		if !requested[chat.ChatID] {
			return nil, errors.New("invalid sidebar grant")
		}
		delete(requested, chat.ChatID)
		if chat.Group {
			watch.groups[chat.ChatID] = true
		}
	}
	return watch, nil
}

func (p *sidebarCoordinator) install(c *Connection, expected, watch *sidebarWatch) error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.state == lifecycleClosed || c.ctx.Err() != nil {
		return context.Canceled
	}
	old := p.watches[c]
	if watch.generation != c.sidebarSerial.Load() || (expected != nil && old != expected) {
		return nil
	}
	previous := 0
	if old != nil {
		previous = len(old.chatIDs)
	}
	if p.references-previous+len(watch.chatIDs) > min(p.server.config.MaxMemberships, 100000) {
		return errRoomLimit
	}
	if old != nil {
		for id := range old.groups {
			if !watch.groups[id] {
				p.leaveLocked(c, id)
			}
		}
	}
	p.references += len(watch.chatIDs) - previous
	p.watches[c] = watch
	for id := range watch.groups {
		feed := p.feeds[id]
		if feed == nil {
			if len(p.feeds) >= p.server.config.MaxRooms {
				p.removeLocked(c)
				return errRoomLimit
			}
			ctx, cancel := context.WithCancel(p.server.ctx)
			feed = &sidebarFeed{cancel: cancel, watchers: make(map[*Connection]*sidebarWatch)}
			p.feeds[id] = feed
			p.wg.Add(1)
			go func(id string, feed *sidebarFeed) { defer p.wg.Done(); p.runFeed(ctx, id, feed) }(id, feed)
		}
		feed.watchers[c] = watch
	}
	return nil
}

func (p *sidebarCoordinator) leaveLocked(c *Connection, id string) {
	if feed := p.feeds[id]; feed != nil {
		delete(feed.watchers, c)
		if len(feed.watchers) == 0 {
			delete(p.feeds, id)
			feed.cancel()
		}
	}
}
func (p *sidebarCoordinator) removeLocked(c *Connection) {
	if watch := p.watches[c]; watch != nil {
		delete(p.watches, c)
		p.references -= len(watch.chatIDs)
		for id := range watch.groups {
			p.leaveLocked(c, id)
		}
	}
}
func (p *sidebarCoordinator) removeIf(c *Connection, expected *sidebarWatch) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.watches[c] == expected {
		p.removeLocked(c)
	}
}
func (p *sidebarCoordinator) remove(c *Connection) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.removeLocked(c)
}
func (p *sidebarCoordinator) current(c *Connection, watch *sidebarWatch) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.watches[c] == watch && watch.generation == c.sidebarSerial.Load() && time.Now().Before(watch.expires)
}
func (p *sidebarCoordinator) deliver(c *Connection, watch *sidebarWatch, event protocol.Event) {
	if !p.current(c, watch) {
		return
	}
	frame, err := protocol.NewEventFrame(event)
	if err == nil {
		c.enqueueFrame(frame, frameGrants{sidebar: watch})
	}
}
func (p *sidebarCoordinator) runFeed(ctx context.Context, id string, feed *sidebarFeed) {
	delay := time.Second
	for ctx.Err() == nil {
		started := time.Now()
		_ = p.source.RunActivity(ctx, id, func(event protocol.Event) {
			p.mu.Lock()
			deliveries := make(map[*Connection]*sidebarWatch, len(feed.watchers))
			if p.feeds[id] == feed {
				for c, w := range feed.watchers {
					deliveries[c] = w
				}
			}
			p.mu.Unlock()
			for c, w := range deliveries {
				p.deliver(c, w, event)
			}
		})
		if time.Since(started) > 30*time.Second {
			delay = time.Second
		}
		timer := time.NewTimer(delay)
		select {
		case <-ctx.Done():
			timer.Stop()
			return
		case <-timer.C:
		}
		delay = min(delay*2, 30*time.Second)
	}
}
func (p *sidebarCoordinator) run() {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	defer func() {
		p.mu.Lock()
		p.state = lifecycleClosed
		for c := range p.watches {
			p.removeLocked(c)
		}
		p.mu.Unlock()
		p.wg.Wait()
	}()
	for {
		select {
		case <-p.server.ctx.Done():
			return
		case <-ticker.C:
			p.sweep()
		}
	}
}
func (p *sidebarCoordinator) sweep() {
	now := time.Now()
	p.mu.Lock()
	due := make(map[*Connection]*sidebarWatch)
	for c, w := range p.watches {
		if c.ctx.Err() != nil || w.generation != c.sidebarSerial.Load() || !now.Before(w.expires) {
			p.removeLocked(c)
			continue
		}
		if !now.Before(w.nextAuth) {
			due[c] = w
		}
	}
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(p.server.ctx, p.server.config.APITimeout)
	defer cancel()
	jobs := make(chan struct {
		c *Connection
		w *sidebarWatch
	})
	var workers sync.WaitGroup
	for range min(8, len(due)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				w, err := p.authorize(ctx, job.c, job.w.chatIDs, job.w.generation)
				switch {
				case err == nil:
					_ = p.install(job.c, job.w, w)
				case errors.Is(err, grpcauth.ErrUnauthorized):
					p.removeIf(job.c, job.w)
				}
			}
		}()
	}
	for c, w := range due {
		select {
		case jobs <- struct {
			c *Connection
			w *sidebarWatch
		}{c, w}:
		case <-ctx.Done():
		}
	}
	close(jobs)
	workers.Wait()
}
