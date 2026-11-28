package presence

import "time"

type revocation struct {
	Revoked []string `json:"r"`
}

func (h *Hub) revoke(ids []string) {
	h.mu.Lock()
	now := time.Now()
	affected := make(map[*watch]map[string]*grant)
	counts := make(map[*watch]struct{})
	for _, id := range ids {
		s := h.subjects[id]
		if s == nil {
			continue
		}
		for wt := range s.watchers {
			if affected[wt] == nil {
				affected[wt] = make(map[string]*grant)
			}
			g := wt.grants[id]
			g.expires = now
			affected[wt][id] = g
		}
		for wt := range s.pendingAdds {
			if affected[wt] == nil {
				affected[wt] = make(map[string]*grant)
			}
		}
		for wt := range s.counters {
			counts[wt] = struct{}{}
		}
	}
	for _, wt := range h.watches {
		if wt.countChat != "" && wt.count == nil {
			counts[wt] = struct{}{}
		}
	}
	var renewals []renewal
	for wt, held := range affected {
		wt.grantGeneration++
		if r, ok := h.startRenewalLocked(wt, held); ok {
			renewals = append(renewals, r)
		}
	}
	refreshes := make([]func(), 0, len(counts))
	for wt := range counts {
		refreshes = append(refreshes, h.startCountRefreshLocked(wt, wt.countChat))
	}
	h.mu.Unlock()
	h.metrics.PresenceEvents.WithLabelValues("revoked").Inc()
	for _, r := range renewals {
		h.renew(r)
	}
	for _, refresh := range refreshes {
		refresh()
	}
}
