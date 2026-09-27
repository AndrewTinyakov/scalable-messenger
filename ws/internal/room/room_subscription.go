package room

import (
	"context"
	"math/rand/v2"
	"time"
)

func subscriptionRetryDelay(attempt int) time.Duration {
	if attempt > 5 {
		attempt = 5
	}
	ceiling := min(time.Second<<attempt, 30*time.Second)
	return ceiling/2 + time.Duration(rand.Int64N(int64(ceiling/2)))
}

func (r *Rooms) listen(ctx context.Context, entry *localRoom) {
	defer r.wg.Done()
	listener, err := r.redis.Subscribe(ctx, entry.name)
	var epoch, last string
	if err == nil {
		epoch, last, err = r.redis.Tail(ctx, entry.name)
	}
	r.mu.Lock()
	entry.err = err
	entry.epoch, entry.lastID = epoch, last
	if err == nil {
		entry.lastPositionAt = time.Now()
	}
	close(entry.ready)
	r.mu.Unlock()
	if err != nil {
		if listener != nil {
			listener.Close()
		}
		r.logger.Error("subscribe room", "room", entry.name, "error", err)
		return
	}
	defer func() {
		if listener != nil {
			_ = listener.Close()
		}
	}()
	for {
		live, err := listener.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			r.logger.Error("Redis room feed stopped", "room", entry.name, "error", err)
			r.failRoom(entry.name)
			_ = listener.Close()
			attempt := 0
			for {
				if ctx.Err() != nil {
					return
				}
				timer := time.NewTimer(subscriptionRetryDelay(attempt))
				if attempt < 5 {
					attempt++
				}
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
				next, subscribeErr := r.redis.Subscribe(ctx, entry.name)
				if subscribeErr != nil {
					continue
				}
				epoch, last, tailErr := r.redis.Tail(ctx, entry.name)
				if tailErr != nil {
					_ = next.Close()
					continue
				}
				listener = next
				r.restorePosition(ctx, entry, epoch, last)
				break
			}
			continue
		}
		r.handleLive(ctx, entry.name, live)
	}
}

// restorePosition runs after the new live subscription is ready. A publication
// made during the outage must be replayed or followed by a fresh SQL fallback
// signal; simply adopting the new tail would hide it from position checks.
func (r *Rooms) restorePosition(ctx context.Context, entry *localRoom, epoch, last string) {
	entry.positionMu.Lock()
	defer entry.positionMu.Unlock()
	current, oldEpoch, oldLast := r.roomPosition(entry.name)
	if current != entry {
		return
	}
	r.mu.Lock()
	entry.lastPositionAt = time.Now()
	r.mu.Unlock()
	if oldEpoch == epoch && oldLast == last {
		return
	}
	if oldEpoch == epoch && oldLast != "" && last != "" && r.replayThrough(ctx, entry.name, oldEpoch, oldLast, last) {
		return
	}
	r.failRoom(entry.name)
	r.setPosition(entry.name, epoch, last)
}
