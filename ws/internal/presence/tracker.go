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
	writing  sync.Mutex
	mu       sync.Mutex
	users    map[string]*localUser
	pending  map[string]bool
	cleared  map[string]time.Time
}

func NewTracker(store Store, recorder LastSeenRecorder, gateway func() string, config Config, logger *slog.Logger) *Tracker {
	return &Tracker{
		store: store, gateway: gateway, config: config, logger: logger,
		lastSeen: newLastSeen(recorder, config, logger),
		wake:     make(chan struct{}, 1),
		users:    make(map[string]*localUser),
		pending:  make(map[string]bool),
		cleared:  make(map[string]time.Time),
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
	now := time.Now()
	t.lastSeen.record(userID, now)
	user.seen = now
	t.pending[userID] = online
	select {
	case t.wake <- struct{}{}:
	default:
	}
}

// Renew writes every locally online user again under the gateway's current
// identity, after Redis lost the registration or the identity changed.
func (t *Tracker) Renew(string) {
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

// RemoveGateway clears the presence a gateway identity left behind, page by
// page from its index. It waits for any write in progress, so a write under
// a retired identity of this gateway cannot land afterwards.
func (t *Tracker) RemoveGateway(ctx context.Context, gateway string) error {
	t.writing.Lock()
	defer t.writing.Unlock()
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
			t.write(ctx)
		case <-retry.C:
			t.write(ctx)
		case now := <-active.C:
			t.refresh(now)
		}
	}
}

// write sends pending state. Renewal waits for it, so no write under an
// identity can land after that identity was cleared.
func (t *Tracker) write(ctx context.Context) {
	t.writing.Lock()
	defer t.writing.Unlock()
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
			delete(t.cleared, userID)
		} else if user != nil {
			t.cleared[userID] = time.Now()
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

// refresh records last seen for users still active and writes their state
// again, which repairs state a Redis failover rolled back. Users cleared in
// the last interval are cleared once more for the same reason.
func (t *Tracker) refresh(now time.Time) {
	t.mu.Lock()
	defer t.mu.Unlock()
	for userID, at := range t.cleared {
		if _, queued := t.pending[userID]; !queued && t.users[userID] == nil {
			t.pending[userID] = false
		}
		if now.Sub(at) >= t.config.LastSeenActive {
			delete(t.cleared, userID)
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
