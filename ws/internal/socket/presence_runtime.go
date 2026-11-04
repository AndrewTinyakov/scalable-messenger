package socket

import (
	"context"
	"sync"
	"time"

	"messenger/ws/internal/protocol"
)

type presenceRenewal struct {
	connection *Connection
	watch      *presenceWatch
}
type presenceDelivery struct {
	connection *Connection
	watch      *presenceWatch
	event      protocol.Event
}

func (p *presenceCoordinator) run() {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-p.server.ctx.Done():
			return
		case <-ticker.C:
			p.sweep()
		}
	}
}

func (p *presenceCoordinator) sweep() {
	started := time.Now()
	defer func() { p.server.metrics.PresenceSweep.Observe(time.Since(started).Seconds()) }()
	p.renewGrants(started)
	p.mu.Lock()
	if started.Before(p.nextSnapshot) {
		p.mu.Unlock()
		return
	}
	p.nextSnapshot = started.Add(presenceRefreshInterval)
	peers := make([]string, 0, len(p.targets))
	for id := range p.targets {
		peers = append(peers, id)
	}
	p.mu.Unlock()
	if len(peers) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(p.server.ctx, p.server.config.APITimeout)
	defer cancel()
	states := p.snapshot(ctx, peers)
	now := time.Now()
	p.mu.Lock()
	deliveries := make([]presenceDelivery, 0, len(p.watches))
	for c, watch := range p.watches {
		if !now.Before(watch.expires) || c.ctx.Err() != nil || watch.generation != c.presenceSerial.Load() {
			p.removeLocked(c)
			continue
		}
		changes := make([]protocol.PresenceStatus, 0, len(watch.userIDs))
		for _, id := range watch.removed {
			changes = append(changes, protocol.PresenceStatus{UserID: id, State: "unknown"})
		}
		watch.removed = nil
		for _, id := range watch.userIDs {
			state := states[id]
			if state == "" {
				state = "unknown"
			}
			if watch.states[id] == state {
				continue
			}
			watch.states[id] = state
			changes = append(changes, protocol.PresenceStatus{UserID: id, State: state})
			p.server.metrics.PresenceStates.WithLabelValues(state).Inc()
		}
		deliveries = append(deliveries, presenceDelivery{c, watch, protocol.Event{Type: protocol.EventPresence, Version: 1, ChatID: watch.chatID, ObservedAt: now.UTC().Format(time.RFC3339Nano), ValidForMS: 15000, Statuses: changes}})
	}
	p.updateMetricsLocked()
	p.mu.Unlock()
	for _, delivery := range deliveries {
		if !p.current(delivery.connection, delivery.watch) {
			continue
		}
		frame, err := protocol.NewEventFrame(delivery.event)
		if err == nil {
			delivery.connection.enqueueFrame(frame, frameGrants{presence: delivery.watch})
		}
	}
}

func (p *presenceCoordinator) snapshot(ctx context.Context, peers []string) map[string]string {
	states := make(map[string]string, len(peers))
	var mu sync.Mutex
	jobs := make(chan []string)
	var workers sync.WaitGroup
	for range min(8, (len(peers)+99)/100) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for ids := range jobs {
				started := time.Now()
				values, err := p.source.Presence(ctx, ids)
				outcome := "success"
				if err != nil {
					outcome = "failed"
				}
				p.server.metrics.PresenceQuery.WithLabelValues(outcome).Observe(time.Since(started).Seconds())
				p.server.metrics.PresenceSnapshots.WithLabelValues(outcome).Inc()
				mu.Lock()
				for _, id := range ids {
					value, present := values[id]
					state := "unknown"
					if err == nil && present {
						state = "offline"
						if value {
							state = "online"
						}
					}
					states[id] = state
				}
				mu.Unlock()
			}
		}()
	}
	for start := 0; start < len(peers); start += 100 {
		select {
		case jobs <- peers[start:min(start+100, len(peers))]:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return states
		}
	}
	close(jobs)
	workers.Wait()
	return states
}

func (p *presenceCoordinator) renewGrants(now time.Time) {
	p.mu.Lock()
	due := make([]presenceRenewal, 0)
	for c, watch := range p.watches {
		if !now.Before(watch.nextAuth) {
			watch.nextAuth = now.Add(20*time.Second + jitteredFirstTick(5*time.Second))
			due = append(due, presenceRenewal{c, watch})
		}
	}
	p.mu.Unlock()
	if len(due) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(p.server.ctx, p.server.config.APITimeout)
	defer cancel()
	jobs := make(chan presenceRenewal)
	var workers sync.WaitGroup
	for range min(8, len(due)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for job := range jobs {
				p.renew(ctx, job, now)
			}
		}()
	}
enqueue:
	for _, job := range due {
		select {
		case jobs <- job:
		case <-ctx.Done():
			break enqueue
		}
	}
	close(jobs)
	workers.Wait()
}

func (p *presenceCoordinator) renew(ctx context.Context, job presenceRenewal, now time.Time) {
	peers, err := p.authorize(ctx, job.connection, job.watch.chatID, job.watch.userIDs)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.watches[job.connection] != job.watch {
		return
	}
	if err != nil || len(peers) == 0 {
		p.removeLocked(job.connection)
		p.updateMetricsLocked()
		return
	}
	allowed := make(map[string]bool, len(peers))
	for _, id := range peers {
		allowed[id] = true
	}
	states := make(map[string]string, len(peers))
	removed := append([]string(nil), job.watch.removed...)
	for _, id := range job.watch.userIDs {
		if allowed[id] {
			states[id] = job.watch.states[id]
			continue
		}
		p.references--
		p.targets[id]--
		if p.targets[id] == 0 {
			delete(p.targets, id)
		}
		removed = append(removed, id)
	}
	p.watches[job.connection] = &presenceWatch{generation: job.watch.generation, chatID: job.watch.chatID, userIDs: peers, expires: now.Add(presenceGrantTTL), nextAuth: job.watch.nextAuth, states: states, removed: removed}
	p.nextSnapshot = time.Time{}
	p.updateMetricsLocked()
}
