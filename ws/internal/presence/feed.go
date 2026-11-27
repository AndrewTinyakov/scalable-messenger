package presence

import (
	"context"
	"encoding/json"
	"slices"
	"strconv"
	"sync"
	"time"

	"messenger/ws/internal/redisroom"
	"messenger/ws/internal/roomname"
)

type bucket struct {
	id       int
	subjects map[string]*subject
	seq      int64
	cancel   context.CancelFunc
	ready    chan struct{}
	once     sync.Once
}

type transition struct {
	UserID   string `json:"u"`
	Version  string `json:"v"`
	Seq      int64  `json:"s"`
	Online   bool   `json:"o"`
	LastSeen int64  `json:"l"`
}

func (h *Hub) bucketLocked(id int) *bucket {
	b := h.buckets[id]
	if b == nil {
		ctx, cancel := context.WithCancel(h.ctx)
		b = &bucket{id: id, subjects: make(map[string]*subject), cancel: cancel, ready: make(chan struct{})}
		h.buckets[id] = b
		h.wg.Add(1)
		go func() { defer h.wg.Done(); h.listen(ctx, b) }()
	}
	return b
}

func (h *Hub) forgetLocked(s *subject) {
	b := h.buckets[s.bucket]
	if b == nil {
		return
	}
	delete(b.subjects, s.id)
	if len(b.subjects) == 0 {
		b.cancel()
		delete(h.buckets, s.bucket)
	}
}

func (h *Hub) listen(ctx context.Context, b *bucket) {
	backoff := 100 * time.Millisecond
	for subscribed := false; ctx.Err() == nil; {
		feed, err := h.store.SubscribePresence(ctx, b.id)
		if err != nil {
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(2*backoff, 5*time.Second)
			continue
		}
		backoff = 100 * time.Millisecond
		if subscribed {
			h.reloadBucketSnapshot(ctx, b)
		}
		subscribed = true
		b.once.Do(func() { close(b.ready) })
		for {
			live, err := feed.Receive(ctx)
			if err != nil {
				break
			}
			h.apply(ctx, b, live)
		}
		_ = feed.Close()
		h.metrics.PresenceResyncs.WithLabelValues("feed_lost").Inc()
	}
}

func (h *Hub) apply(ctx context.Context, b *bucket, live redisroom.Live) {
	var message struct {
		transition
		revocation
	}
	if err := json.Unmarshal([]byte(live.Raw), &message); err != nil {
		h.metrics.PresenceEvents.WithLabelValues("invalid").Inc()
		return
	}
	if message.Revoked != nil {
		var keys map[string]json.RawMessage
		_ = json.Unmarshal([]byte(live.Raw), &keys)
		foreign := slices.ContainsFunc(message.Revoked, func(id string) bool { return roomname.PresenceBucketOf(id) != b.id })
		_, exact := keys["r"]
		if len(keys) != 1 || !exact || len(message.Revoked) == 0 || foreign {
			h.metrics.PresenceEvents.WithLabelValues("invalid").Inc()
			return
		}
		h.revoke(message.Revoked)
		return
	}
	event := message.transition
	if roomname.PresenceBucketOf(event.UserID) != b.id {
		h.metrics.PresenceEvents.WithLabelValues("invalid").Inc()
		return
	}
	version, err := strconv.ParseInt(event.Version, 10, 64)
	if err != nil {
		h.metrics.PresenceEvents.WithLabelValues("invalid").Inc()
		return
	}
	h.mu.Lock()
	gap := b.seq != 0 && event.Seq != b.seq+1
	b.seq = event.Seq
	s := b.subjects[event.UserID]
	result := "unwatched"
	if s != nil {
		result = "stale"
		if version > s.state.Version {
			result = "matched"
			s.state = redisroom.PresenceState{Online: event.Online, Version: version, LastSeen: event.LastSeen}
			s.known = true
			h.markLocked(s, time.Now())
		}
	}
	h.mu.Unlock()
	h.metrics.PresenceEvents.WithLabelValues(result).Inc()
	if gap {
		h.metrics.PresenceResyncs.WithLabelValues("sequence_gap").Inc()
		h.reloadBucketSnapshot(ctx, b)
	}
}

func (h *Hub) reloadBucketSnapshot(ctx context.Context, b *bucket) {
	h.mu.Lock()
	ids := make([]string, 0, len(b.subjects))
	for id, s := range b.subjects {
		s.known = false
		s.state.Version = 0
		ids = append(ids, id)
	}
	h.mu.Unlock()
	loadCtx, cancel := context.WithTimeout(ctx, h.config.Timeout)
	defer cancel()
	if err := h.loadSnapshotsAfterSubscribe(loadCtx, ids); err != nil {
		h.logger.Warn("resync presence bucket", "bucket", b.id, "error", err)
	}
}

func (h *Hub) awaitBucketSubscriptions(ctx context.Context, ids []string) error {
	h.mu.Lock()
	waits := make(map[int]*bucket)
	for _, id := range ids {
		if s := h.subjects[id]; s != nil {
			waits[s.bucket] = h.buckets[s.bucket]
		}
	}
	h.mu.Unlock()
	for _, b := range waits {
		if b == nil {
			continue
		}
		select {
		case <-b.ready:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return nil
}

func (h *Hub) loadSnapshotsAfterSubscribe(ctx context.Context, ids []string) error {
	if len(ids) == 0 {
		return nil
	}
	if err := h.awaitBucketSubscriptions(ctx, ids); err != nil {
		return err
	}
	for start := 0; start < len(ids); start += h.config.MaxWatched {
		chunk := ids[start:min(start+h.config.MaxWatched, len(ids))]
		states, sequences, err := h.store.PresenceSnapshot(ctx, chunk)
		if err != nil {
			return err
		}
		now := time.Now()
		h.mu.Lock()
		for id, state := range states {
			s := h.subjects[id]
			if s == nil || (s.known && state.Version <= s.state.Version) {
				continue
			}
			s.state, s.known = state, true
			h.markLocked(s, now)
		}
		for id, seq := range sequences {
			if b := h.buckets[id]; b != nil && b.seq == 0 {
				b.seq = seq
			}
		}
		h.mu.Unlock()
	}
	return nil
}
