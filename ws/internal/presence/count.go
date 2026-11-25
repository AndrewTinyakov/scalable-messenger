package presence

import (
	"context"

	"messenger/ws/internal/protocol"
)

// onlineCount tracks how many members of a small group are online for one
// socket. Only the count is sent; members stay private to the gateway.
type onlineCount struct {
	chatID  string
	members []string
	total   int
	sent    int
	dirty   bool
}

// WatchOnlineCount replaces the socket's online count. An empty chat ID
// stops it. Groups above the limit get no count.
func (h *Hub) WatchOnlineCount(ctx context.Context, w Watcher, chatID string) error {
	h.mu.Lock()
	wt := h.watchLocked(w)
	h.clearCountLocked(wt)
	h.mu.Unlock()
	if chatID == "" {
		return nil
	}
	total, members, err := h.auth.OnlineCountMembers(ctx, w.PresenceSession(), chatID, h.config.MaxCountGroup)
	if err != nil || len(members) == 0 {
		return err
	}
	h.mu.Lock()
	if h.watches[w] != wt {
		h.mu.Unlock()
		return nil
	}
	h.clearCountLocked(wt)
	wt.count = &onlineCount{chatID: chatID, members: members, total: total, sent: -1, dirty: true}
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

func (h *Hub) countEventLocked(wt *watch) (protocol.Event, bool) {
	count := wt.count
	if count == nil || !count.dirty {
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
