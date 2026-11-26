package fleet

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"log/slog"
	"sync"
	"time"
)

var ErrRenewing = errors.New("gateway is restoring its connection counts")

type Store interface {
	AdmitConnection(context.Context, string, string, int) (bool, error)
	SetConnections(context.Context, string, string, int) error
	UnindexConnections(context.Context, string, string) error
	Heartbeat(context.Context, string, time.Duration) (registered, dead bool, err error)
	ExpiredGateways(context.Context, int64) ([]string, error)
	ClaimGateway(context.Context, string) (bool, error)
	GatewayUsers(context.Context, string, uint64) ([]string, uint64, error)
	ForgetGateway(context.Context, string) error
}

// GatewayState is the per-gateway state kept outside connection counts.
// RemoveGateway clears what a dead gateway identity left behind, using its
// own index; Renew writes local state again after Redis lost it.
type GatewayState interface {
	RemoveGateway(context.Context, string) error
	Renew()
}

type Config struct {
	ConnectionLimit int
	Heartbeat       time.Duration
	TTL             time.Duration
	Timeout         time.Duration
}

// Fleet owns this gateway's identity and its per-user connection counts.
// Redis holds one count per user and gateway, changed only when a
// connection opens or closes, never while sockets are idle. Every Redis
// change for one user runs under that user's lock, so the absolute count
// it writes is never older than one already written.
type Fleet struct {
	store  Store
	state  GatewayState
	config Config
	logger *slog.Logger
	wake   chan struct{}
	// admitting is held shared by each admission's Redis check and
	// exclusively while the heartbeat detects and starts a renewal, so no
	// admission can count against state that a renewal replaces.
	admitting sync.RWMutex
	mu        sync.Mutex
	id        string
	renewal   renewalPhase
	counts    map[string]int
	dirty     map[string]bool
	locks     map[string]*userLock
	retired   []string
}

// renewalPhase blocks admission while Redis may undercount this gateway's
// connections: while a new identity registers, and until every local count
// has been written again after Redis lost them.
type renewalPhase uint8

const (
	renewalNone renewalPhase = iota
	renewalRegistering
	renewalRestoring
)

// userLock is a mutex whose waiters can give up when their context ends.
type userLock struct {
	held    chan struct{}
	holders int
}

func New(store Store, state GatewayState, config Config, logger *slog.Logger) *Fleet {
	return &Fleet{
		store: store, state: state, config: config, logger: logger, wake: make(chan struct{}, 1), id: newID(),
		counts: make(map[string]int), dirty: make(map[string]bool), locks: make(map[string]*userLock),
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

func (f *Fleet) lockUser(ctx context.Context, userID string) (func(), error) {
	f.mu.Lock()
	lock := f.locks[userID]
	if lock == nil {
		lock = &userLock{held: make(chan struct{}, 1)}
		f.locks[userID] = lock
	}
	lock.holders++
	f.mu.Unlock()
	leave := func() {
		f.mu.Lock()
		if lock.holders--; lock.holders == 0 {
			delete(f.locks, userID)
		}
		f.mu.Unlock()
	}
	select {
	case lock.held <- struct{}{}:
		return func() {
			<-lock.held
			leave()
		}, nil
	case <-ctx.Done():
		leave()
		return nil, ctx.Err()
	}
}

func (f *Fleet) Admit(ctx context.Context, userID string) (bool, error) {
	unlock, err := f.lockUser(ctx, userID)
	if err != nil {
		return false, err
	}
	defer unlock()
	f.admitting.RLock()
	defer f.admitting.RUnlock()
	f.mu.Lock()
	if f.renewal != renewalNone {
		f.mu.Unlock()
		return false, ErrRenewing
	}
	f.counts[userID]++
	id := f.id
	f.mu.Unlock()
	admitted, err := f.store.AdmitConnection(ctx, userID, id, f.config.ConnectionLimit)
	if err != nil || !admitted {
		f.Release(userID)
	}
	return admitted, err
}

// Release forgets one local connection; the writer stores the new count.
func (f *Fleet) Release(userID string) {
	f.mu.Lock()
	if f.counts[userID]--; f.counts[userID] <= 0 {
		delete(f.counts, userID)
	}
	f.dirty[userID] = true
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
		users := make([]string, 0, len(f.dirty))
		for userID := range f.dirty {
			users = append(users, userID)
		}
		f.mu.Unlock()
		for _, userID := range users {
			f.writeUser(ctx, userID)
		}
		f.mu.Lock()
		if f.renewal == renewalRestoring && len(f.dirty) == 0 {
			f.renewal = renewalNone
		}
		f.mu.Unlock()
	}
}

// writeUser stores one user's current local count, and drops them from the
// cleanup index once it is zero. It holds the user's lock, so no admission
// for that user runs meanwhile.
func (f *Fleet) writeUser(ctx context.Context, userID string) {
	unlock, err := f.lockUser(ctx, userID)
	if err != nil {
		return
	}
	defer unlock()
	f.mu.Lock()
	id, count := f.id, f.counts[userID]
	delete(f.dirty, userID)
	f.mu.Unlock()
	err = f.write(ctx, func(ctx context.Context) error { return f.store.SetConnections(ctx, userID, id, count) })
	if err == nil && count == 0 {
		err = f.write(ctx, func(ctx context.Context) error { return f.store.UnindexConnections(ctx, userID, id) })
	}
	if err != nil {
		f.mu.Lock()
		f.dirty[userID] = true
		f.mu.Unlock()
	}
}

func (f *Fleet) write(ctx context.Context, operation func(context.Context) error) error {
	writeCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	defer cancel()
	return operation(writeCtx)
}

func (f *Fleet) heartbeat(ctx context.Context) {
	f.admitting.Lock()
	renewed := f.renew(ctx)
	f.admitting.Unlock()
	if renewed {
		f.state.Renew()
		f.signal()
	}
}

// renew extends the registration and reports whether state must be written
// again. If Redis lost the registration, every count is restored; if another
// gateway declared this one dead, a new identity is registered first and
// the old one is cleaned up like any dead gateway.
func (f *Fleet) renew(ctx context.Context) bool {
	f.mu.Lock()
	id := f.id
	f.mu.Unlock()
	registered, dead, err := f.beat(ctx, id)
	if err != nil {
		f.logger.Warn("gateway heartbeat", "error", err)
		return false
	}
	if registered {
		return false
	}
	if dead {
		f.mu.Lock()
		f.renewal = renewalRegistering
		f.mu.Unlock()
		next := newID()
		if _, _, err := f.beat(ctx, next); err != nil {
			f.logger.Warn("register new gateway identity", "error", err)
			return false
		}
		f.logger.Warn("gateway was removed by the fleet; registered a new identity", "previous", id, "gateway", next)
		f.mu.Lock()
		f.id = next
		f.retired = append(f.retired, id)
		f.mu.Unlock()
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.renewal = renewalRestoring
	for userID := range f.counts {
		f.dirty[userID] = true
	}
	return true
}

func (f *Fleet) beat(ctx context.Context, id string) (bool, bool, error) {
	beatCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
	defer cancel()
	return f.store.Heartbeat(beatCtx, id, f.config.TTL)
}

func (f *Fleet) reap(ctx context.Context) {
	f.mu.Lock()
	retired := append([]string(nil), f.retired...)
	f.mu.Unlock()
	for _, gateway := range retired {
		if err := f.clean(ctx, gateway, f.localUsers()); err != nil {
			f.logger.Warn("clean retired gateway identity", "gateway", gateway, "error", err)
			continue
		}
		f.mu.Lock()
		for i, candidate := range f.retired {
			if candidate == gateway {
				f.retired = append(f.retired[:i], f.retired[i+1:]...)
				break
			}
		}
		f.mu.Unlock()
	}
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
	return f.clean(ctx, gateway, nil)
}

func (f *Fleet) localUsers() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	users := make([]string, 0, len(f.counts))
	for userID := range f.counts {
		users = append(users, userID)
	}
	return users
}

// clean removes a dead gateway identity's state through its indexes and the
// given users, then forgets the identity. For a retired identity of this
// gateway the users are its local ones, which also covers an admission whose
// index entry another gateway's cleanup already deleted. Clearing a count
// takes that user's lock, so a write still running under the retired
// identity finishes first.
func (f *Fleet) clean(ctx context.Context, gateway string, users []string) error {
	if err := f.state.RemoveGateway(ctx, gateway); err != nil {
		return err
	}
	clearUsers := func(users []string) error {
		for _, userID := range users {
			unlock, err := f.lockUser(ctx, userID)
			if err != nil {
				return err
			}
			err = f.write(ctx, func(ctx context.Context) error { return f.store.SetConnections(ctx, userID, gateway, 0) })
			unlock()
			if err != nil {
				return err
			}
		}
		return nil
	}
	if err := clearUsers(users); err != nil {
		return err
	}
	var cursor uint64
	for {
		pageCtx, cancel := context.WithTimeout(ctx, f.config.Timeout)
		users, next, err := f.store.GatewayUsers(pageCtx, gateway, cursor)
		cancel()
		if err != nil {
			return err
		}
		if err := clearUsers(users); err != nil {
			return err
		}
		if cursor = next; cursor == 0 {
			break
		}
	}
	return f.write(ctx, func(ctx context.Context) error { return f.store.ForgetGateway(ctx, gateway) })
}
