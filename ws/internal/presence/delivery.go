package presence

import (
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

func (h *Hub) flushPending(now time.Time) {
	h.mu.Lock()
	for s := range h.hot {
		if now.Sub(s.pushedAt) >= h.config.HotInterval {
			delete(h.hot, s)
			h.markLocked(s, now)
		}
	}
	watches := make([]*watch, 0, len(h.pending))
	for wt := range h.pending {
		watches = append(watches, wt)
		delete(h.pending, wt)
	}
	h.mu.Unlock()
	for _, wt := range watches {
		h.flushWatch(wt)
	}
}

// flushWatch sends a socket its rejected users and, unless its page is
// hidden, its changed statuses and online count. Building and queueing hold
// the socket's flush lock, so frames reach the socket in the order built.
func (h *Hub) flushWatch(wt *watch) {
	wt.flush.Lock()
	defer wt.flush.Unlock()
	h.mu.Lock()
	if h.watches[wt.watcher] != wt {
		h.mu.Unlock()
		return
	}
	now := time.Now()
	var statuses []protocol.PresenceStatus
	if !wt.hidden {
		for id := range wt.dirty {
			s, g := h.subjects[id], wt.grants[id]
			if s == nil || g == nil {
				delete(wt.dirty, id)
				continue
			}
			if s.known && now.Before(g.expires) {
				statuses = append(statuses, status(s, g))
				delete(wt.dirty, id)
			}
		}
	}
	var unavailable []string
	for id := range wt.unavailable {
		unavailable = append(unavailable, id)
	}
	clear(wt.unavailable)
	var events []protocol.Event
	if len(statuses) > 0 || len(unavailable) > 0 {
		events = append(events, protocol.Event{Type: protocol.EventPresence, Version: 1, Statuses: statuses, Unavailable: unavailable})
	}
	if !wt.hidden {
		if event, ok := h.countEventLocked(wt, now); ok {
			events = append(events, event)
		}
	}
	h.mu.Unlock()
	for _, event := range events {
		wt.watcher.Enqueue(event)
		h.metrics.PresenceDeliveries.Inc()
	}
}

func status(s *subject, g *grant) protocol.PresenceStatus {
	seen := time.UnixMilli(s.state.LastSeen)
	if g.visibility.LastSeen.After(seen) {
		seen = g.visibility.LastSeen
	}
	if s.state.LastSeen == 0 && g.visibility.LastSeen.IsZero() {
		seen = time.Time{}
	}
	if g.visibility.Level == grpcauth.PresenceCoarse {
		return protocol.PresenceStatus{UserID: s.id, LastSeen: coarse(s.state.Online, seen, time.Now())}
	}
	result := protocol.PresenceStatus{UserID: s.id, Online: s.state.Online}
	if !s.state.Online && !seen.IsZero() {
		result.LastSeenAt = seen.UTC().Format(time.RFC3339Nano)
	}
	return result
}

func coarse(online bool, seen, now time.Time) string {
	age := now.Sub(seen)
	switch {
	case online || (!seen.IsZero() && age < 3*24*time.Hour):
		return "recently"
	case !seen.IsZero() && age < 7*24*time.Hour:
		return "within_week"
	case !seen.IsZero() && age < 30*24*time.Hour:
		return "within_month"
	default:
		return "long_ago"
	}
}
