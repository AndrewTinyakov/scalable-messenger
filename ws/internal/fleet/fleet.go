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
	SetConnections(context.Context, string, string, int) error
	Heartbeat(context.Context, string, time.Duration) (registered, dead bool, err error)
	ExpiredGateways(context.Context, int64) ([]string, error)
	ClaimGateway(context.Context, string) (bool, error)
	GatewayUsers(context.Context, string, uint64) ([]string, uint64, error)
	RemoveGatewayConnections(context.Context, string, []string) error
	ForgetGateway(context.Context, string) error
}

// Cleaner removes per-user state that a dead gateway left behind.
type Cleaner interface {
	RemoveGateway(context.Context, string, []string) error
}

type Config struct {
	ConnectionLimit int
	Heartbeat       time.Duration
	TTL             time.Duration
	Timeout         time.Duration
}

// Fleet owns this gateway's identity and its per-user connection counts.
// Redis holds one count per user and gateway, written only when a
// connection opens or closes, never while sockets are idle.
type Fleet struct {
	store    Store
	cleaners []Cleaner
	config   Config
	logger   *slog.Logger
	wake     chan struct{}
	mu       sync.Mutex
	id       string
	counts   map[string]int
	stale    map[string]bool
	renewed  []func()
}

func New(store Store, config Config, logger *slog.Logger) *Fleet {
	return &Fleet{store: store, config: config, logger: logger, wake: make(chan struct{}, 1), id: newID(), counts: make(map[string]int), stale: make(map[string]bool)}
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

// OnRenewed registers a callback for when this gateway takes a new identity
// and must write its state again.
func (f *Fleet) OnRenewed(callback func()) {
	f.mu.Lock()
	f.renewed = append(f.renewed, callback)
	f.mu.Unlock()
}

func (f *Fleet) Admit(ctx context.Context, userID string) (bool, error) {
	f.mu.Lock()
	f.counts[userID]++
	id := f.id
	f.mu.Unlock()
	admitted, err := f.store.AdmitConnection(ctx, userID, id, f.config.ConnectionLimit)
	if err != nil || !admitted {
		f.release(userID, err != nil)
	}
	return admitted, err
}

func (f *Fleet) Release(userID string) { f.release(userID, true) }

func (f *Fleet) release(userID string, write bool) {
	f.mu.Lock()
	if f.counts[userID]--; f.counts[userID] <= 0 {
		delete(f.counts, userID)
	}
	if write {
		f.stale[userID] = true
	}
	f.mu.Unlock()
	if write {
		f.signal()
	}
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
		id := f.id
		pending := make(map[string]int, len(f.stale))
		for userID := range f.stale {
			pending[userID] = f.counts[userID]
		}
		clear(f.stale)
		f.mu.Unlock()
		for userID, count := range pending {
			writeCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
			err := f.store.SetConnections(writeCtx, userID, id, count)
			cancel()
			if err != nil {
				f.mu.Lock()
				f.stale[userID] = true
				f.mu.Unlock()
			}
		}
	}
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
	for userID := range f.counts {
		f.stale[userID] = true
	}
	callbacks := append([]func(){}, f.renewed...)
	f.mu.Unlock()
	if dead {
		f.logger.Warn("gateway was removed by the fleet; registering again", "gateway", id)
		beatCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
		_, _, _ = f.store.Heartbeat(beatCtx, renewedID, f.config.TTL)
		cancel()
	}
	for _, callback := range callbacks {
		callback()
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
	var cursor uint64
	for {
		pageCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
		users, next, err := f.store.GatewayUsers(pageCtx, gateway, cursor)
		if err == nil && len(users) > 0 {
			err = f.store.RemoveGatewayConnections(pageCtx, gateway, users)
			f.mu.Lock()
			cleaners := append([]Cleaner(nil), f.cleaners...)
			f.mu.Unlock()
			for _, cleaner := range cleaners {
				if err == nil {
					err = cleaner.RemoveGateway(pageCtx, gateway, users)
				}
			}
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
