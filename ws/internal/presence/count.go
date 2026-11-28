package presence

import (
	"context"
	"errors"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

type onlineCount struct {
	chatID  string
	members []string
	total   int
	sent    countValue
	dirty   bool
	expires time.Time
}

type countValue struct{ online, members int }

var unsentCount = countValue{-1, -1}

func (h *Hub) WatchOnlineCount(ctx context.Context, w Watcher, chatID string) error {
	h.mu.Lock()
	wt := h.watchLocked(w)
	var generation uint64
	if wt != nil {
		h.clearCountLocked(wt)
		wt.countChat = chatID
		wt.countGeneration++
		generation = wt.countGeneration
	}
	h.mu.Unlock()
	if wt == nil || chatID == "" {
		return nil
	}
	return h.resolveCount(ctx, wt, chatID, unsentCount, generation)
}

func (h *Hub) refreshCount(wt *watch, chatID string) {
	h.mu.Lock()
	refresh := h.startCountRefreshLocked(wt, chatID)
	h.mu.Unlock()
	refresh()
}

func (h *Hub) startCountRefreshLocked(wt *watch, chatID string) func() {
	if chatID == "" || wt.countChat != chatID {
		return func() {}
	}
	wt.countGeneration++
	generation, sent := wt.countGeneration, unsentCount
	if wt.count != nil {
		wt.count.expires = time.Now()
		sent = wt.count.sent
	}
	return func() {
		h.wg.Add(1)
		go func() {
			defer h.wg.Done()
			ctx, cancel := context.WithTimeout(h.ctx, h.config.Timeout)
			defer cancel()
			err := h.resolveCount(ctx, wt, chatID, sent, generation)
			if errors.Is(err, grpcauth.ErrUnauthorized) {
				h.mu.Lock()
				if wt.countGeneration == generation {
					h.clearCountLocked(wt)
					wt.countChat = ""
				}
				h.mu.Unlock()
			}
		}()
	}
}

func (h *Hub) resolveCount(ctx context.Context, wt *watch, chatID string, sent countValue, generation uint64) error {
	h.mu.Lock()
	wt.resolving = generation
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		if wt.resolving == generation {
			wt.resolving = 0
		}
		h.mu.Unlock()
	}()
	total, members, err := h.auth.OnlineCountMembers(ctx, wt.watcher.PresenceSession(), chatID, h.config.MaxCountGroup)
	if err != nil {
		return err
	}
	h.mu.Lock()
	if h.watches[wt.watcher] != wt || wt.countGeneration != generation {
		h.mu.Unlock()
		return nil
	}
	h.clearCountLocked(wt)
	if len(members) == 0 {
		wt.countChat = ""
		h.mu.Unlock()
		return nil
	}
	wt.count = &onlineCount{chatID: chatID, members: members, total: total, sent: sent, dirty: true, expires: time.Now().Add(h.config.GrantTTL)}
	var unknown []string
	for _, id := range members {
		s := h.attachLocked(id)
		s.counters[wt] = struct{}{}
		if !s.known {
			unknown = append(unknown, id)
		}
	}
	h.pending[wt] = struct{}{}
	h.mu.Unlock()
	if err := h.loadSnapshotsAfterSubscribe(ctx, unknown); err != nil {
		return err
	}
	h.flushWatch(wt)
	return nil
}

func (h *Hub) clearCountLocked(wt *watch) {
	if wt.count == nil {
		return
	}
	for _, id := range wt.count.members {
		if s := h.subjects[id]; s != nil {
			delete(s.counters, wt)
			h.releaseLocked(s)
		}
	}
	wt.count = nil
}

func (h *Hub) countEventLocked(wt *watch, now time.Time) (protocol.Event, bool) {
	count := wt.count
	if count == nil || !count.dirty || !now.Before(count.expires) {
		return protocol.Event{}, false
	}
	online := 0
	for _, id := range count.members {
		s := h.subjects[id]
		if s == nil || !s.known {
			return protocol.Event{}, false
		}
		if s.state.Online {
			online++
		}
	}
	count.dirty = false
	value := countValue{online, count.total}
	if value == count.sent {
		return protocol.Event{}, false
	}
	count.sent = value
	return protocol.Event{Type: protocol.EventOnlineCount, Version: 1, ChatID: count.chatID, Online: online, Members: count.total}, true
}
