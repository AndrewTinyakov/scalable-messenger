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

type Tracker struct {
	store           Store
	gateway         func() string
	config          Config
	logger          *slog.Logger
	lastSeen        *lastSeen
	wake            chan struct{}
	redisWriteMu    sync.Mutex
	mu              sync.Mutex
	users           map[string]*localUser
	pending         map[string]bool
	recentlyCleared map[string]time.Time
}

func NewTracker(store Store, recorder LastSeenRecorder, gateway func() string, config Config, logger *slog.Logger) *Tracker {
	return &Tracker{
		store: store, gateway: gateway, config: config, logger: logger,
		lastSeen:        newLastSeen(recorder, config, logger),
		wake:            make(chan struct{}, 1),
		users:           make(map[string]*localUser),
		pending:         make(map[string]bool),
		recentlyCleared: make(map[string]time.Time),
	}
}

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
	now := time.Now()
	t.lastSeen.record(userID, now)
	user.seen = now
	t.pending[userID] = online
	t.signal()
}

func (t *Tracker) Renew() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, user := range t.users {
		if user.online {
			t.pending[userID] = true
		}
	}
	t.signal()
}

func (t *Tracker) signal() {
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

func (t *Tracker) RemoveGateway(ctx context.Context, gateway string) error {
	t.redisWriteMu.Lock()
	defer t.redisWriteMu.Unlock()
	var cursor uint64
	for {
		users, next, err := t.store.PresenceGatewayUsers(ctx, gateway, cursor)
		if err != nil {
			return err
		}
		offline := make(map[string]bool, len(users))
		for _, userID := range users {
			offline[userID] = false
		}
		for _, err := range t.store.SetPresence(ctx, gateway, offline) {
			return err
		}
		if cursor = next; cursor == 0 {
			return t.store.ForgetPresenceGateway(ctx, gateway)
		}
	}
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
			t.writePending(ctx)
		case <-retry.C:
			t.writePending(ctx)
		case now := <-active.C:
			t.refresh(now)
		}
	}
}

func (t *Tracker) writePending(ctx context.Context) {
	t.redisWriteMu.Lock()
	defer t.redisWriteMu.Unlock()
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
		user := t.users[userID]
		if online {
			delete(t.recentlyCleared, userID)
		} else if user != nil {
			t.recentlyCleared[userID] = time.Now()
		}
		if user != nil {
			if !user.online && user.active == 0 && user.grace == nil {
				delete(t.users, userID)
			}
		}
	}
	if len(failed) > 0 {
		t.logger.Warn("write presence", "failed", len(failed))
	}
}

func (t *Tracker) refresh(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, at := range t.recentlyCleared {
		if _, queued := t.pending[userID]; !queued && t.users[userID] == nil {
			t.pending[userID] = false
		}
		if now.Sub(at) >= t.config.LastSeenActive {
			delete(t.recentlyCleared, userID)
		}
	}
	for userID, user := range t.users {
		if user.active == 0 {
			continue
		}
		if now.Sub(user.seen) >= t.config.LastSeenActive {
			t.lastSeen.record(userID, now)
			user.seen = now
		}
		if _, queued := t.pending[userID]; !queued && user.online {
			t.pending[userID] = true
		}
	}
	t.signal()
}
