package presence

import "time"

// revocation asks gateways to check access to users again after a change
// that may have ended it, such as a removal from a group. The outbox
// publisher sends it on each user's bucket, so it reaches only gateways that
// watch them. It carries no sequence; grant expiry covers a lost one.
type revocation struct {
	Revoked []string `json:"r"`
}

// revoke suspends every local grant on the users and checks them again,
// along with online counts that may include them. Pairs that still share a
// chat keep access once the check answers.
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
		// An add already in flight may have read access that is now gone.
		for wt := range s.adding {
			if affected[wt] == nil {
				affected[wt] = make(map[string]*grant)
			}
		}
		for wt := range s.counters {
			counts[wt] = struct{}{}
		}
	}
	// A roster still being read may include a revoked user.
	for _, wt := range h.watches {
		if wt.countChat != "" && wt.count == nil {
			counts[wt] = struct{}{}
		}
	}
	var renewals []renewal
	for wt, held := range affected {
		// Results read before now install suspended.
		wt.authorized++
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
