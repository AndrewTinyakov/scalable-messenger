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
		if !wt.hidden {
			watches = append(watches, wt)
			delete(h.pending, wt)
		}
	}
	h.mu.Unlock()
	for _, wt := range watches {
		h.flushWatch(wt)
	}
}

// flushWatch sends a socket its changed statuses and online count.
func (h *Hub) flushWatch(wt *watch) {
	h.mu.Lock()
	if wt.hidden || h.watches[wt.watcher] != wt {
		h.mu.Unlock()
		return
	}
	var events []protocol.Event
	statuses := make([]protocol.PresenceStatus, 0, len(wt.dirty))
	for id := range wt.dirty {
		s, g := h.subjects[id], wt.grants[id]
		if s == nil || g == nil || !s.known {
			continue
		}
		statuses = append(statuses, status(s, g))
		delete(wt.dirty, id)
	}
	if len(statuses) > 0 || len(wt.unavailable) > 0 {
		events = append(events, protocol.Event{Type: protocol.EventPresence, Version: 1, Statuses: statuses, Unavailable: wt.unavailable})
		wt.unavailable = nil
	}
	if event, ok := h.countEventLocked(wt); ok {
		events = append(events, event)
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
