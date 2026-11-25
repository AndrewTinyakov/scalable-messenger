package fleet

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"sync"
	"time"
)

type Store interface {
	AdmitConnection(context.Context, string, string, int) (bool, error)
	ReleaseConnections(context.Context, string, string, int) error
	UnindexConnections(context.Context, string, string) error
	SetConnections(context.Context, string, string, int) error
	Heartbeat(context.Context, string, time.Duration) (registered, dead bool, err error)
	ExpiredGateways(context.Context, int64) ([]string, error)
	ClaimGateway(context.Context, string) (bool, error)
	GatewayUsers(context.Context, string, uint64) ([]string, uint64, error)
	RemoveGatewayConnections(context.Context, string, []string) error
	ForgetGateway(context.Context, string) error
}

// Cleaner removes the state a dead gateway left behind, using its own index.
type Cleaner interface {
	RemoveGateway(context.Context, string) error
}

type Config struct {
	ConnectionLimit int
	Heartbeat       time.Duration
	TTL             time.Duration
	Timeout         time.Duration
}

// Fleet owns this gateway's identity and its per-user connection counts.
// Redis holds one count per user and gateway, changed only when a
// connection opens or closes, never while sockets are idle. All Redis
// changes for one user run under that user's lock, so they apply in order.
type Fleet struct {
	store    Store
	cleaners []Cleaner
	config   Config
	logger   *slog.Logger
	wake     chan struct{}
	mu       sync.Mutex
	id       string
	counts   map[string]int
	released map[string]int
	rewrite  map[string]bool
	unindex  map[string]bool
	locks    map[string]*userLock
	renewed  []func(string)
}

type userLock struct {
	sync.Mutex
	holders int
}

func New(store Store, config Config, logger *slog.Logger) *Fleet {
	return &Fleet{
		store: store, config: config, logger: logger, wake: make(chan struct{}, 1), id: newID(),
		counts: make(map[string]int), released: make(map[string]int), rewrite: make(map[string]bool),
		unindex: make(map[string]bool), locks: make(map[string]*userLock),
	}
}

func (f *Fleet) lockUser(userID string) func() {
	f.mu.Lock()
	lock := f.locks[userID]
	if lock == nil {
		lock = &userLock{}
		f.locks[userID] = lock
	}
	lock.holders++
	f.mu.Unlock()
	lock.Lock()
	return func() {
		lock.Unlock()
		f.mu.Lock()
		if lock.holders--; lock.holders == 0 {
			delete(f.locks, userID)
		}
		f.mu.Unlock()
	}
}

func newID() string {
	var raw [12]byte
	_, _ = rand.Read(raw[:])
	return hex.EncodeToString(raw[:])
}

func (f *Fleet) ID() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.id
}

// AddCleaner registers state to remove when another gateway dies.
func (f *Fleet) AddCleaner(cleaner Cleaner) {
	f.mu.Lock()
	f.cleaners = append(f.cleaners, cleaner)
	f.mu.Unlock()
}

// OnRenewed registers a callback for when this gateway must write its state
// again. It receives the identity whose state may be stale, which equals the
// current identity when Redis lost the registration.
func (f *Fleet) OnRenewed(callback func(string)) {
	f.mu.Lock()
	f.renewed = append(f.renewed, callback)
	f.mu.Unlock()
}

func (f *Fleet) Admit(ctx context.Context, userID string) (bool, error) {
	unlock := f.lockUser(userID)
	defer unlock()
	f.mu.Lock()
	f.counts[userID]++
	id := f.id
	f.mu.Unlock()
	admitted, err := f.store.AdmitConnection(ctx, userID, id, f.config.ConnectionLimit)
	if err != nil || !admitted {
		f.mu.Lock()
		if f.counts[userID]--; f.counts[userID] <= 0 {
			delete(f.counts, userID)
		}
		if err != nil {
			// The outcome is unknown, so write the absolute count instead.
			f.rewrite[userID] = true
		}
		f.unindex[userID] = true
		f.mu.Unlock()
		f.signal()
	}
	return admitted, err
}

// Release forgets one local connection. Redis is decremented rather than
// overwritten so other connections keep their count.
func (f *Fleet) Release(userID string) {
	f.mu.Lock()
	if f.counts[userID]--; f.counts[userID] <= 0 {
		delete(f.counts, userID)
	}
	if !f.rewrite[userID] {
		f.released[userID]++
	}
	f.unindex[userID] = true
	f.mu.Unlock()
	f.signal()
}

func (f *Fleet) signal() {
	select {
	case f.wake <- struct{}{}:
	default:
	}
}

func (f *Fleet) Run(ctx context.Context) {
	var wg sync.WaitGroup
	wg.Add(3)
	go func() { defer wg.Done(); f.writeCounts(ctx) }()
	go func() { defer wg.Done(); f.every(ctx, f.config.Heartbeat, f.heartbeat) }()
	go func() { defer wg.Done(); f.every(ctx, f.config.Heartbeat/2, f.reap) }()
	wg.Wait()
}

func (f *Fleet) every(ctx context.Context, interval time.Duration, action func(context.Context)) {
	action(ctx)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			action(ctx)
		}
	}
}

func (f *Fleet) writeCounts(ctx context.Context) {
	retry := time.NewTicker(time.Second)
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-f.wake:
		case <-retry.C:
		}
		f.mu.Lock()
		users := make(map[string]bool, len(f.released)+len(f.rewrite)+len(f.unindex))
		for _, pending := range []map[string]bool{f.rewrite, f.unindex} {
			for userID := range pending {
				users[userID] = true
			}
		}
		for userID := range f.released {
			users[userID] = true
		}
		f.mu.Unlock()
		for userID := range users {
			f.writeUser(ctx, userID)
		}
	}
}

// writeUser brings Redis in line with one user's local connections. It
// holds the user's lock, so no admission for that user runs meanwhile.
func (f *Fleet) writeUser(ctx context.Context, userID string) {
	unlock := f.lockUser(userID)
	defer unlock()
	f.mu.Lock()
	id, count, closed, rewrite, unindex := f.id, f.counts[userID], f.released[userID], f.rewrite[userID], f.unindex[userID]
	delete(f.released, userID)
	delete(f.rewrite, userID)
	delete(f.unindex, userID)
	f.mu.Unlock()
	var err error
	switch {
	case rewrite:
		err = f.write(ctx, func(ctx context.Context) error { return f.store.SetConnections(ctx, userID, id, count) })
	case closed > 0:
		err = f.write(ctx, func(ctx context.Context) error { return f.store.ReleaseConnections(ctx, userID, id, closed) })
	}
	if err == nil && unindex && count == 0 {
		err = f.write(ctx, func(ctx context.Context) error { return f.store.UnindexConnections(ctx, userID, id) })
	}
	if err != nil {
		f.mu.Lock()
		if rewrite {
			f.rewrite[userID] = true
		} else if closed > 0 {
			f.released[userID] += closed
		}
		f.unindex[userID] = f.unindex[userID] || unindex
		f.mu.Unlock()
	}
}

func (f *Fleet) write(ctx context.Context, operation func(context.Context) error) error {
	writeCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	defer cancel()
	return operation(writeCtx)
}

func (f *Fleet) heartbeat(ctx context.Context) {
	f.mu.Lock()
	id := f.id
	f.mu.Unlock()
	beatCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	registered, dead, err := f.store.Heartbeat(beatCtx, id, f.config.TTL)
	cancel()
	if err != nil {
		f.logger.Warn("gateway heartbeat", "error", err)
		return
	}
	if registered {
		return
	}
	f.mu.Lock()
	if dead {
		f.id = newID()
	}
	renewedID := f.id
	clear(f.released)
	for userID := range f.counts {
		f.rewrite[userID] = true
	}
	users := make([]string, 0, len(f.counts))
	for userID := range f.counts {
		users = append(users, userID)
	}
	callbacks := append([]func(string){}, f.renewed...)
	f.mu.Unlock()
	if dead {
		f.logger.Warn("gateway was removed by the fleet; registering again", "gateway", id)
		_ = f.write(ctx, func(ctx context.Context) error {
			for _, userID := range users {
				if err := f.store.SetConnections(ctx, userID, id, 0); err != nil {
					return err
				}
			}
			_, _, err := f.store.Heartbeat(ctx, renewedID, f.config.TTL)
			return err
		})
	}
	for _, callback := range callbacks {
		callback(id)
	}
	f.signal()
}

func (f *Fleet) reap(ctx context.Context) {
	listCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	expired, err := f.store.ExpiredGateways(listCtx, 10)
	cancel()
	if err != nil {
		return
	}
	own := f.ID()
	for _, gateway := range expired {
		if gateway == own {
			continue
		}
		if err := f.remove(ctx, gateway); err != nil {
			f.logger.Warn("remove dead gateway", "gateway", gateway, "error", err)
		}
	}
}

func (f *Fleet) remove(ctx context.Context, gateway string) error {
	claimCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	claimed, err := f.store.ClaimGateway(claimCtx, gateway)
	cancel()
	if err != nil || !claimed {
		return err
	}
	f.mu.Lock()
	cleaners := append([]Cleaner(nil), f.cleaners...)
	f.mu.Unlock()
	for _, cleaner := range cleaners {
		if err := cleaner.RemoveGateway(ctx, gateway); err != nil {
			return err
		}
	}
	var cursor uint64
	for {
		pageCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
		users, next, err := f.store.GatewayUsers(pageCtx, gateway, cursor)
		if err == nil && len(users) > 0 {
			err = f.store.RemoveGatewayConnections(pageCtx, gateway, users)
		}
		cancel()
		if err != nil {
			return err
		}
		if cursor = next; cursor == 0 {
			break
		}
	}
	forgetCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	defer cancel()
	return f.store.ForgetGateway(forgetCtx, gateway)
}
