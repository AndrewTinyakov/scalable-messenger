package presence

import (
	"context"
	"log/slog"
	"maps"
	"math/rand/v2"
	"slices"
	"sync"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/redisroom"
	"messenger/ws/internal/roomname"
)

// subject is one watched user, shared by every local socket that watches it.
type subject struct {
	id       string
	bucket   int
	state    redisroom.PresenceState
	known    bool
	watchers map[*watch]struct{}
	counters map[*watch]struct{}
	// adding counts each socket's authorizations for this user in flight.
	adding    map[*watch]int
	idleSince time.Time
	pushedAt  time.Time
}

type grant struct {
	visibility grpcauth.Visibility
	expires    time.Time
}

type watch struct {
	watcher     Watcher
	flush       sync.Mutex
	grants      map[string]*grant
	dirty       map[string]struct{}
	unavailable map[string]struct{}
	hidden      bool
	renewing    bool
	recheck     bool
	authorized  uint64
	count       *onlineCount
	countChat   string
	counted     uint64
	resolving   uint64
}

// Hub delivers presence transitions to local sockets. It keeps one entry
// per watched user and one Redis subscription per presence bucket.
type Hub struct {
	store    Store
	auth     Authorizer
	config   Config
	logger   *slog.Logger
	metrics  *monitoring.PresenceMetrics
	ctx      context.Context
	wg       sync.WaitGroup
	mu       sync.Mutex
	subjects map[string]*subject
	buckets  map[int]*bucket
	watches  map[Watcher]*watch
	pending  map[*watch]struct{}
	hot      map[*subject]struct{}
}

// NewHub creates a hub whose subscriptions live until ctx ends.
func NewHub(ctx context.Context, store Store, auth Authorizer, config Config, logger *slog.Logger, metrics *monitoring.PresenceMetrics) *Hub {
	return &Hub{
		store: store, auth: auth, config: config, logger: logger, metrics: metrics, ctx: ctx,
		subjects: make(map[string]*subject), buckets: make(map[int]*bucket), watches: make(map[Watcher]*watch),
		pending: make(map[*watch]struct{}), hot: make(map[*subject]struct{}),
	}
}

// Run delivers and maintains presence until the hub's context ends.
func (h *Hub) Run() {
	ctx := h.ctx
	flush := time.NewTicker(h.config.FlushInterval)
	defer flush.Stop()
	sweep := time.NewTicker(5 * time.Second)
	defer sweep.Stop()
	for {
		select {
		case <-ctx.Done():
			h.wg.Wait()
			return
		case now := <-flush.C:
			h.flushPending(now)
		case now := <-sweep.C:
			h.sweep(now)
		}
	}
}

// Watch changes the set of users a socket observes. Only added users are
// authorized; the rest keep their grants.
func (h *Hub) Watch(ctx context.Context, w Watcher, add, remove []string, reset bool) error {
	h.mu.Lock()
	wt := h.watchLocked(w)
	if wt == nil {
		h.mu.Unlock()
		return nil
	}
	if reset {
		for id := range wt.grants {
			h.dropLocked(wt, id)
		}
	}
	for _, id := range remove {
		h.dropLocked(wt, id)
	}
	requested := make([]string, 0, len(add))
	for _, id := range add {
		if wt.grants[id] != nil {
			continue
		}
		if len(wt.grants)+len(requested) >= h.config.MaxWatched {
			h.markUnavailableLocked(wt, id)
			continue
		}
		requested = append(requested, id)
		h.attachLocked(id).adding[wt]++
	}
	generation := wt.authorized
	h.mu.Unlock()
	defer h.flushWatch(wt)
	if len(requested) == 0 {
		return nil
	}
	// The users' buckets are subscribed before access is read, so a
	// revocation published after the answer reaches this gateway and fences it.
	if err := h.awaitBuckets(ctx, requested); err != nil {
		h.abandon(wt, requested)
		return err
	}
	visibility, err := h.auth.PresenceVisibility(ctx, w.PresenceSession(), requested)
	if err != nil {
		h.abandon(wt, requested)
		return err
	}
	h.mu.Lock()
	h.finishAddsLocked(wt, requested)
	h.mu.Unlock()
	unknown := h.grant(wt, requested, visibility, generation, nil)
	// A revocation during the check installed the result suspended; check again now.
	h.mu.Lock()
	r, renew := renewal{}, false
	if generation != wt.authorized {
		r, renew = h.startRenewalLocked(wt, maps.Clone(wt.grants))
	}
	h.mu.Unlock()
	if renew {
		h.renew(r)
	}
	return h.load(ctx, unknown)
}

// abandon forgets adds whose authorization failed.
func (h *Hub) abandon(wt *watch, ids []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.finishAddsLocked(wt, ids)
}

func (h *Hub) finishAddsLocked(wt *watch, ids []string) {
	for _, id := range ids {
		if s := h.subjects[id]; s != nil {
			if s.adding[wt]--; s.adding[wt] <= 0 {
				delete(s.adding, wt)
			}
			h.releaseLocked(s)
		}
	}
}

// SetVisible pauses status delivery while the socket's page is hidden.
func (h *Hub) SetVisible(w Watcher, visible bool) {
	h.mu.Lock()
	wt := h.watches[w]
	if wt == nil {
		h.mu.Unlock()
		return
	}
	wt.hidden = !visible
	h.mu.Unlock()
	if visible {
		h.flushWatch(wt)
	}
}

// Revalidate suspends a socket's grants and online count and checks them
// again, after an event that may have revoked access.
func (h *Hub) Revalidate(w Watcher) {
	h.mu.Lock()
	wt := h.watches[w]
	if wt == nil {
		h.mu.Unlock()
		return
	}
	now := time.Now()
	wt.authorized++
	for _, g := range wt.grants {
		g.expires = now
	}
	if wt.count != nil {
		wt.count.expires = now
	}
	r, renew := h.startRenewalLocked(wt, maps.Clone(wt.grants))
	refreshCount := h.startCountRefreshLocked(wt, wt.countChat)
	h.mu.Unlock()
	if renew {
		h.renew(r)
	}
	refreshCount()
}

func (h *Hub) Remove(w Watcher) {
	h.mu.Lock()
	defer h.mu.Unlock()
	wt := h.watches[w]
	if wt == nil {
		return
	}
	for id := range wt.grants {
		h.dropLocked(wt, id)
	}
	h.clearCountLocked(wt)
	delete(h.watches, w)
	delete(h.pending, wt)
	h.metrics.PresenceWatches.Set(float64(len(h.watches)))
}

// watchLocked returns the socket's watch, creating it unless the socket has
// already closed.
func (h *Hub) watchLocked(w Watcher) *watch {
	wt := h.watches[w]
	if wt == nil && !w.Closed() {
		wt = &watch{watcher: w, grants: make(map[string]*grant), dirty: make(map[string]struct{}), unavailable: make(map[string]struct{})}
		h.watches[w] = wt
		h.metrics.PresenceWatches.Set(float64(len(h.watches)))
	}
	return wt
}

func (h *Hub) markUnavailableLocked(wt *watch, id string) {
	if len(wt.unavailable) < h.config.MaxWatched {
		wt.unavailable[id] = struct{}{}
	}
}

// grant installs an authorization result. A result read before a later
// revocation event is installed suspended, so it renews before any delivery.
// A renewal passes the grants it read, and applies only to those still held.
func (h *Hub) grant(wt *watch, ids []string, visibility map[string]grpcauth.Visibility, generation uint64, held map[string]*grant) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.watches[wt.watcher] != wt {
		return nil
	}
	expires := time.Now().Add(h.config.GrantTTL - rand.N(h.config.GrantTTL/10))
	if generation != wt.authorized {
		expires = time.Now()
	}
	var unknown []string
	for _, id := range ids {
		if held != nil && wt.grants[id] != held[id] {
			continue
		}
		v := visibility[id]
		if v.Level == grpcauth.PresenceNone {
			h.dropLocked(wt, id)
			h.markUnavailableLocked(wt, id)
			continue
		}
		if wt.grants[id] == nil {
			s := h.attachLocked(id)
			s.watchers[wt] = struct{}{}
			if !s.known {
				unknown = append(unknown, id)
			}
		}
		wt.grants[id] = &grant{visibility: v, expires: expires}
		wt.dirty[id] = struct{}{}
		delete(wt.unavailable, id)
	}
	h.pending[wt] = struct{}{}
	return unknown
}

func (h *Hub) attachLocked(id string) *subject {
	s := h.subjects[id]
	if s == nil {
		s = &subject{id: id, bucket: roomname.PresenceBucketOf(id), watchers: make(map[*watch]struct{}), counters: make(map[*watch]struct{}), adding: make(map[*watch]int)}
		h.subjects[id] = s
		h.bucketLocked(s.bucket).subjects[id] = s
		h.metrics.PresenceSubjects.Set(float64(len(h.subjects)))
	}
	s.idleSince = time.Time{}
	return s
}

func (h *Hub) dropLocked(wt *watch, id string) {
	if wt.grants[id] == nil {
		return
	}
	delete(wt.grants, id)
	delete(wt.dirty, id)
	if s := h.subjects[id]; s != nil {
		delete(s.watchers, wt)
		h.releaseLocked(s)
	}
}

func (h *Hub) releaseLocked(s *subject) {
	if len(s.watchers) == 0 && len(s.counters) == 0 && len(s.adding) == 0 {
		s.idleSince = time.Now()
	}
}

// markLocked queues a changed subject for every socket that observes it,
// at most once per hot interval for widely watched users.
func (h *Hub) markLocked(s *subject, now time.Time) {
	if len(s.watchers) > h.config.HotWatchers && now.Sub(s.pushedAt) < h.config.HotInterval {
		h.hot[s] = struct{}{}
		return
	}
	s.pushedAt = now
	for wt := range s.watchers {
		wt.dirty[s.id] = struct{}{}
		h.pending[wt] = struct{}{}
	}
	for wt := range s.counters {
		wt.count.dirty = true
		h.pending[wt] = struct{}{}
	}
}

// renewal is a claimed check of some of a socket's grants.
type renewal struct {
	wt         *watch
	held       map[string]*grant
	generation uint64
}

// startRenewalLocked claims the socket's renewal of the held grants, or asks
// the running one to check all its grants again when it finishes.
func (h *Hub) startRenewalLocked(wt *watch, held map[string]*grant) (renewal, bool) {
	if wt.renewing {
		wt.recheck = true
		return renewal{}, false
	}
	if len(held) == 0 {
		return renewal{}, false
	}
	wt.renewing = true
	return renewal{wt, held, wt.authorized}, true
}

// renew authorizes the held grants again. Its result is fenced by the
// generation captured when it started, and applies only to grants that were
// not replaced meanwhile, so it never overwrites a newer authorization.
func (h *Hub) renew(r renewal) {
	wt := r.wt
	ids := slices.Collect(maps.Keys(r.held))
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		ctx, cancel := context.WithTimeout(h.ctx, h.config.Timeout)
		defer cancel()
		visibility, err := h.auth.PresenceVisibility(ctx, wt.watcher.PresenceSession(), ids)
		if err != nil {
			h.logger.Warn("renew presence grants", "error", err)
		} else {
			h.grant(wt, ids, visibility, r.generation, r.held)
		}
		h.mu.Lock()
		wt.renewing = false
		recheck := wt.recheck
		wt.recheck = false
		next, again := renewal{}, false
		if recheck {
			next, again = h.startRenewalLocked(wt, maps.Clone(wt.grants))
		}
		h.mu.Unlock()
		if again {
			h.renew(next)
			return
		}
		h.flushWatch(wt)
	}()
}

func (h *Hub) sweep(now time.Time) {
	h.mu.Lock()
	var unknown []string
	for id, s := range h.subjects {
		if !s.idleSince.IsZero() && now.Sub(s.idleSince) >= h.config.Linger {
			delete(h.subjects, id)
			h.forgetLocked(s)
			continue
		}
		if !s.known && s.idleSince.IsZero() {
			unknown = append(unknown, id)
		}
	}
	h.metrics.PresenceSubjects.Set(float64(len(h.subjects)))
	type countRefresh struct {
		wt     *watch
		chatID string
	}
	var renewals []renewal
	var counts []countRefresh
	for _, wt := range h.watches {
		stale := wt.count == nil || !now.Before(wt.count.expires)
		if wt.countChat != "" && stale && wt.resolving != wt.counted {
			counts = append(counts, countRefresh{wt, wt.countChat})
		}
		expired := false
		for _, g := range wt.grants {
			expired = expired || !now.Before(g.expires)
		}
		if expired && !wt.renewing {
			if r, ok := h.startRenewalLocked(wt, maps.Clone(wt.grants)); ok {
				renewals = append(renewals, r)
			}
		}
	}
	h.mu.Unlock()
	for _, r := range renewals {
		h.renew(r)
	}
	for _, c := range counts {
		h.refreshCount(c.wt, c.chatID)
	}
	if len(unknown) > 0 {
		ctx, cancel := context.WithTimeout(h.ctx, h.config.Timeout)
		if err := h.load(ctx, unknown); err != nil {
			h.logger.Warn("load presence", "error", err)
		}
		cancel()
	}
}
