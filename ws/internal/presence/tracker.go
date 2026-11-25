package presence

import (
	"context"
	"log/slog"
	"sync"
	"time"
)

type localUser struct {
	active int
	online bool
	grace  *time.Timer
	seen   time.Time
}

// Tracker publishes this gateway's share of each user's presence. It writes
// to Redis only when its active connection count for a user crosses zero,
// after a grace period on the way down.
type Tracker struct {
	store    Store
	gateway  func() string
	config   Config
	logger   *slog.Logger
	lastSeen *lastSeen
	wake     chan struct{}
	mu       sync.Mutex
	users    map[string]*localUser
	pending  map[string]bool
}

func NewTracker(store Store, recorder LastSeenRecorder, gateway func() string, config Config, logger *slog.Logger) *Tracker {
	return &Tracker{
		store: store, gateway: gateway, config: config, logger: logger,
		lastSeen: newLastSeen(recorder, config, logger),
		wake:     make(chan struct{}, 1),
		users:    make(map[string]*localUser),
		pending:  make(map[string]bool),
	}
}

// SetActive adds or removes one active connection for a user.
func (t *Tracker) SetActive(userID string, active bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	user := t.users[userID]
	if user == nil {
		if !active {
			return
		}
		user = &localUser{}
		t.users[userID] = user
	}
	if !active {
		if user.active == 0 {
			return
		}
		if user.active--; user.active == 0 {
			user.grace = time.AfterFunc(t.config.Grace, func() { t.expire(userID, user) })
		}
		return
	}
	if user.active++; user.grace != nil {
		user.grace.Stop()
		user.grace = nil
	}
	if !user.online {
		t.queueLocked(userID, user, true)
	}
}

func (t *Tracker) expire(userID string, user *localUser) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.users[userID] != user || user.active > 0 {
		return
	}
	user.grace = nil
	t.queueLocked(userID, user, false)
}

func (t *Tracker) queueLocked(userID string, user *localUser, online bool) {
	user.online = online
	t.pending[userID] = online
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

// Rewrite queues every locally active user again, after this gateway's
// identity or Redis state was lost.
func (t *Tracker) Rewrite() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, user := range t.users {
		if user.online {
			t.queueLocked(userID, user, true)
		}
	}
}

// RemoveGateway clears presence a dead gateway left behind.
func (t *Tracker) RemoveGateway(ctx context.Context, gateway string, userIDs []string) error {
	offline := make(map[string]bool, len(userIDs))
	for _, userID := range userIDs {
		offline[userID] = false
	}
	for _, err := range t.store.SetPresence(ctx, gateway, offline) {
		return err
	}
	return nil
}

func (t *Tracker) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(1)
	go func() { defer wg.Done(); t.lastSeen.run(ctx) }()
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	active := time.NewTicker(t.config.LastSeenActive)
	defer active.Stop()
	for {
		select {
		case <-ctx.Done():
			wg.Wait()
			return
		case <-t.wake:
			t.write(ctx)
		case <-retry.C:
			t.write(ctx)
		case now := <-active.C:
			t.recordActive(now)
		}
	}
}

func (t *Tracker) write(ctx context.Context) {
	t.mu.Lock()
	if len(t.pending) == 0 {
		t.mu.Unlock()
		return
	}
	batch := t.pending
	t.pending = make(map[string]bool)
	t.mu.Unlock()
	writeCtx, cancel := context.WithTimeout(ctx, t.config.Timeout)
	failed := t.store.SetPresence(writeCtx, t.gateway(), batch)
	cancel()
	now := time.Now()
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, online := range batch {
		if _, newer := t.pending[userID]; newer {
			continue
		}
		if failed[userID] != nil {
			t.pending[userID] = online
			continue
		}
		t.lastSeen.record(userID, now)
		if user := t.users[userID]; user != nil {
			user.seen = now
			if !user.online && user.active == 0 && user.grace == nil {
				delete(t.users, userID)
			}
		}
	}
	if len(failed) > 0 {
		t.logger.Warn("write presence", "failed", len(failed))
	}
}

func (t *Tracker) recordActive(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, user := range t.users {
		if user.active > 0 && now.Sub(user.seen) >= t.config.LastSeenActive {
			t.lastSeen.record(userID, now)
			user.seen = now
		}
	}
}
