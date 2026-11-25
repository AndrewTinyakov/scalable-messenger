package presence

import (
	"context"
	"errors"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

// onlineCount tracks how many members of a small group are online for one
// socket. Only the count is sent; members stay private to the gateway. The
// roster is authorized again when it expires or access may have changed.
type onlineCount struct {
	chatID  string
	members []string
	total   int
	sent    int
	dirty   bool
	expires time.Time
}

// WatchOnlineCount replaces the socket's online count. An empty chat ID
// stops it. Groups above the limit get no count.
func (h *Hub) WatchOnlineCount(ctx context.Context, w Watcher, chatID string) error {
	h.mu.Lock()
	wt := h.watchLocked(w)
	var generation uint64
	if wt != nil {
		h.clearCountLocked(wt)
		wt.counted++
		generation = wt.counted
	}
	h.mu.Unlock()
	if wt == nil || chatID == "" {
		return nil
	}
	return h.resolveCount(ctx, wt, chatID, -1, generation)
}

// refreshCount authorizes the given roster again unless it was replaced.
func (h *Hub) refreshCount(wt *watch, count *onlineCount) {
	h.mu.Lock()
	refresh := h.startCountRefreshLocked(wt, count)
	h.mu.Unlock()
	refresh()
}

// startCountRefreshLocked advances the count generation, so any refresh
// already running can no longer install its roster, and returns the new
// refresh to start after unlocking.
func (h *Hub) startCountRefreshLocked(wt *watch, count *onlineCount) func() {
	if count == nil || wt.count != count {
		return func() {}
	}
	wt.counted++
	generation := wt.counted
	return func() { h.runCountRefresh(wt, count, generation) }
}

func (h *Hub) runCountRefresh(wt *watch, count *onlineCount, generation uint64) {
	h.wg.Add(1)
	go func() {
		defer h.wg.Done()
		ctx, cancel := context.WithTimeout(h.ctx, h.config.Timeout)
		defer cancel()
		err := h.resolveCount(ctx, wt, count.chatID, count.sent, generation)
		if errors.Is(err, grpcauth.ErrUnauthorized) {
			h.mu.Lock()
			if wt.counted == generation {
				h.clearCountLocked(wt)
			}
			h.mu.Unlock()
		}
	}()
}

// resolveCount authorizes the roster and installs it if no newer count
// watch or invalidation started meanwhile, keeping the last count the
// socket received so an unchanged count is not sent again.
func (h *Hub) resolveCount(ctx context.Context, wt *watch, chatID string, sent int, generation uint64) error {
	total, members, err := h.auth.OnlineCountMembers(ctx, wt.watcher.PresenceSession(), chatID, h.config.MaxCountGroup)
	if err != nil {
		return err
	}
	h.mu.Lock()
	if h.watches[wt.watcher] != wt || wt.counted != generation {
		h.mu.Unlock()
		return nil
	}
	h.clearCountLocked(wt)
	if len(members) == 0 {
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
	if err := h.load(ctx, unknown); err != nil {
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
	if online == count.sent {
		return protocol.Event{}, false
	}
	count.sent = online
	return protocol.Event{Type: protocol.EventOnlineCount, Version: 1, ChatID: count.chatID, Online: online, Members: count.total}, true
}
