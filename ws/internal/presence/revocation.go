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
// along with online counts that include them. Pairs that still share a chat
// keep access once the check answers.
func (h *Hub) revoke(ids []string) {
	h.mu.Lock()
	now := time.Now()
	// An authorization already in flight may have read access that is now
	// gone, so none installs a live grant.
	for _, wt := range h.watches {
		wt.authorized++
	}
	affected := make(map[*watch]map[string]*grant)
	var counts []func()
	for _, id := range ids {
		s := h.subjects[id]
		if s == nil {
			continue
		}
		for wt := range s.watchers {
			g := wt.grants[id]
			g.expires = now
			if affected[wt] == nil {
				affected[wt] = make(map[string]*grant)
			}
			affected[wt][id] = g
		}
		for wt := range s.counters {
			counts = append(counts, h.startCountRefreshLocked(wt, wt.countChat))
		}
	}
	type renewal struct {
		wt         *watch
		held       map[string]*grant
		generation uint64
	}
	var renewals []renewal
	for wt, held := range affected {
		if wt.renewing {
			wt.recheck = true
			continue
		}
		wt.renewing = true
		renewals = append(renewals, renewal{wt, held, wt.authorized})
	}
	h.mu.Unlock()
	h.metrics.PresenceEvents.WithLabelValues("revoked").Add(float64(len(ids)))
	for _, r := range renewals {
		h.renew(r.wt, r.held, r.generation)
	}
	for _, refresh := range counts {
		refresh()
	}
}
