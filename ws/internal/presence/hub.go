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

type subject struct {
	id          string
	bucket      int
	state       redisroom.PresenceState
	known       bool
	watchers    map[*watch]struct{}
	counters    map[*watch]struct{}
	pendingAdds map[*watch]int
	idleSince   time.Time
	pushedAt    time.Time
}

type grant struct {
	visibility grpcauth.Visibility
	expires    time.Time
}

type watch struct {
	watcher         Watcher
	deliveryMu      sync.Mutex
	grants          map[string]*grant
	dirty           map[string]struct{}
	unavailable     map[string]struct{}
	hidden          bool
	renewing        bool
	recheck         bool
	grantGeneration uint64
	count           *onlineCount
	countChat       string
	countGeneration uint64
	resolving       uint64
}

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

func NewHub(ctx context.Context, store Store, auth Authorizer, config Config, logger *slog.Logger, metrics *monitoring.PresenceMetrics) *Hub {
	return &Hub{
		store: store, auth: auth, config: config, logger: logger, metrics: metrics, ctx: ctx,
		subjects: make(map[string]*subject), buckets: make(map[int]*bucket), watches: make(map[Watcher]*watch),
		pending: make(map[*watch]struct{}), hot: make(map[*subject]struct{}),
	}
}

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
		h.attachLocked(id).pendingAdds[wt]++
	}
	generation := wt.grantGeneration
	h.mu.Unlock()
	defer h.flushWatch(wt)
	if len(requested) == 0 {
		return nil
	}
	if err := h.awaitBucketSubscriptions(ctx, requested); err != nil {
		h.abandonAdds(wt, requested)
		return err
	}
	visibility, err := h.auth.PresenceVisibility(ctx, w.PresenceSession(), requested)
	if err != nil {
		h.abandonAdds(wt, requested)
		return err
	}
	h.mu.Lock()
	h.finishAddsLocked(wt, requested)
	unknown := h.installGrantsLocked(wt, requested, visibility, generation, nil)
	r, renew := renewal{}, false
	if generation != wt.grantGeneration {
		r, renew = h.startRenewalLocked(wt, maps.Clone(wt.grants))
	}
	h.mu.Unlock()
	if renew {
		h.renew(r)
	}
	return h.loadSnapshotsAfterSubscribe(ctx, unknown)
}

func (h *Hub) abandonAdds(wt *watch, ids []string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.finishAddsLocked(wt, ids)
}

func (h *Hub) finishAddsLocked(wt *watch, ids []string) {
	for _, id := range ids {
		if s := h.subjects[id]; s != nil {
			if s.pendingAdds[wt]--; s.pendingAdds[wt] <= 0 {
				delete(s.pendingAdds, wt)
			}
			h.releaseLocked(s)
		}
	}
}

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

func (h *Hub) Revalidate(w Watcher) {
	h.mu.Lock()
	wt := h.watches[w]
	if wt == nil {
		h.mu.Unlock()
		return
	}
	now := time.Now()
	wt.grantGeneration++
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

func (h *Hub) installGrants(wt *watch, ids []string, visibility map[string]grpcauth.Visibility, generation uint64, held map[string]*grant) []string {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.installGrantsLocked(wt, ids, visibility, generation, held)
}

func (h *Hub) installGrantsLocked(wt *watch, ids []string, visibility map[string]grpcauth.Visibility, generation uint64, held map[string]*grant) []string {
	if h.watches[wt.watcher] != wt {
		return nil
	}
	expires := time.Now().Add(h.config.GrantTTL - rand.N(h.config.GrantTTL/10))
	if generation != wt.grantGeneration {
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
		s = &subject{id: id, bucket: roomname.PresenceBucketOf(id), watchers: make(map[*watch]struct{}), counters: make(map[*watch]struct{}), pendingAdds: make(map[*watch]int)}
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
	if len(s.watchers) == 0 && len(s.counters) == 0 && len(s.pendingAdds) == 0 {
		s.idleSince = time.Now()
	}
}

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

type renewal struct {
	wt         *watch
	held       map[string]*grant
	generation uint64
}

func (h *Hub) startRenewalLocked(wt *watch, held map[string]*grant) (renewal, bool) {
	if wt.renewing {
		wt.recheck = true
		return renewal{}, false
	}
	if len(held) == 0 {
		return renewal{}, false
	}
	wt.renewing = true
	return renewal{wt, held, wt.grantGeneration}, true
}

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
			h.installGrants(wt, ids, visibility, r.generation, r.held)
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
		if wt.countChat != "" && stale && wt.resolving != wt.countGeneration {
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
		if err := h.loadSnapshotsAfterSubscribe(ctx, unknown); err != nil {
			h.logger.Warn("load presence", "error", err)
		}
		cancel()
	}
}
