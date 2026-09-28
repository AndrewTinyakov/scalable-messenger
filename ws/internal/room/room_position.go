package room

import (
	"context"
	"math/rand/v2"
	"strconv"
	"strings"
	"sync"
	"time"

	"messenger/ws/internal/redisroom"
)

func (r *Rooms) RunChecks(ctx context.Context) {
	r.wg.Add(1)
	defer r.wg.Done()
	jitter := time.NewTimer(time.Duration(rand.Int64N(int64(r.checkInterval))))
	select {
	case <-ctx.Done():
		jitter.Stop()
		return
	case <-jitter.C:
	}
	timer := time.NewTimer(r.checkInterval)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			started := time.Now()
			r.checkAll(ctx)
			pause := min(r.checkInterval, time.Second)
			remaining := r.checkInterval - time.Since(started)
			if remaining > pause {
				pause = remaining
			}
			timer.Reset(pause)
		}
	}
}

func (r *Rooms) checkAll(ctx context.Context) {
	started := time.Now()
	defer func() {
		r.metrics.PositionSweep.Observe(time.Since(started).Seconds())
		r.mu.Lock()
		oldest := 0.0
		for _, entry := range r.rooms {
			positionAt := entry.lastPositionAt
			if entry.lastLiveAt.After(positionAt) {
				positionAt = entry.lastLiveAt
			}
			age := time.Since(positionAt).Seconds()
			if age > oldest {
				oldest = age
			}
		}
		r.mu.Unlock()
		r.metrics.OldestPositionAge.Set(oldest)
	}()
	r.mu.Lock()
	names := make([]string, 0, len(r.rooms))
	for name := range r.rooms {
		names = append(names, name)
	}
	r.mu.Unlock()
	if len(names) == 0 {
		return
	}
	jobs := make(chan string)
	var workers sync.WaitGroup
	for range min(16, len(names)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for name := range jobs {
				r.checkRoom(ctx, name)
			}
		}()
	}
	for _, name := range names {
		select {
		case jobs <- name:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return
		}
	}
	close(jobs)
	workers.Wait()
}

func (r *Rooms) roomPosition(name string) (*localRoom, string, string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.rooms[name]
	if entry == nil {
		return nil, "", ""
	}
	return entry, entry.epoch, entry.lastID
}

func (r *Rooms) checkRoom(ctx context.Context, name string) {
	entry, _, _ := r.roomPosition(name)
	if entry == nil {
		return
	}
	select {
	case <-entry.ready:
	default:
		return
	}
	entry.positionMu.Lock()
	defer entry.positionMu.Unlock()
	current, oldEpoch, oldLast := r.roomPosition(name)
	if current != entry {
		return
	}
	r.mu.Lock()
	recentLive := r.checkInterval > 0 && time.Since(entry.lastLiveAt) < r.checkInterval
	r.mu.Unlock()
	if recentLive {
		return
	}
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	epoch, last, err := r.redis.Tail(checkCtx, name)
	cancel()
	if err != nil {
		r.failRoom(name)
		return
	}
	r.mu.Lock()
	if r.rooms[name] == entry {
		entry.lastPositionAt = time.Now()
	}
	r.mu.Unlock()
	r.reconcilePosition(ctx, name, oldEpoch, oldLast, epoch, last)
}

func (r *Rooms) handleLive(ctx context.Context, name string, live redisroom.Live) {
	if live.Event.Type == "message_saved" && live.Event.CreatedAt != "" {
		if created, err := time.Parse(time.RFC3339Nano, live.Event.CreatedAt); err == nil {
			r.metrics.SavedEventLag.Observe(max(0, time.Since(created).Seconds()))
		}
	}
	entry, _, _ := r.roomPosition(name)
	if entry == nil {
		return
	}
	entry.positionMu.Lock()
	defer entry.positionMu.Unlock()
	current, oldEpoch, oldLast := r.roomPosition(name)
	if current != entry {
		return
	}
	if oldEpoch == live.Epoch {
		if oldLast != "" && !streamAfter(live.StreamID, oldLast) {
			return
		}
		if oldLast != "" && (!live.HasPrevious || live.PreviousStreamID != oldLast) {
			r.reconcilePosition(ctx, name, oldEpoch, oldLast, live.Epoch, live.StreamID)
			return
		}
		if oldLast == "" && live.HasPrevious && live.PreviousStreamID != "" {
			r.reconcilePosition(ctx, name, oldEpoch, oldLast, live.Epoch, live.StreamID)
			return
		}
	}
	r.dispatch(name, live.Event)
}

// reconcilePosition runs while the room's position lock is held. Redis can
// fill a gap only when both positions belong to the same epoch and the old
// cursor is still retained; every other change needs SQL catch-up.
func (r *Rooms) reconcilePosition(ctx context.Context, name, oldEpoch, oldLast, epoch, last string) {
	if oldEpoch == epoch && oldLast == last {
		return
	}
	if oldEpoch == epoch && oldLast != "" && last != "" && r.replayThrough(ctx, name, oldEpoch, oldLast, last) {
		return
	}
	r.failRoom(name)
	r.setPosition(name, epoch, last)
}

func (r *Rooms) replayThrough(ctx context.Context, name, epoch, after, through string) bool {
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	items, err := r.redis.Replay(checkCtx, name, epoch, after, r.replayLimit)
	cancel()
	if err != nil {
		return false
	}
	sawThrough := false
	for _, item := range items {
		if item.StreamID == through {
			sawThrough = true
			break
		}
	}
	if !sawThrough {
		return false
	}
	for _, item := range items {
		r.dispatch(name, item.Event)
	}
	return true
}

func (r *Rooms) setPosition(name, epoch, last string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry := r.rooms[name]; entry != nil {
		entry.epoch = epoch
		entry.lastID = last
	}
}

func streamAfter(candidate, previous string) bool {
	if previous == "" {
		return true
	}
	parse := func(value string) (uint64, uint64, bool) {
		parts := strings.SplitN(value, "-", 2)
		if len(parts) != 2 {
			return 0, 0, false
		}
		a, errA := strconv.ParseUint(parts[0], 10, 64)
		b, errB := strconv.ParseUint(parts[1], 10, 64)
		return a, b, errA == nil && errB == nil
	}
	a, b, okA := parse(candidate)
	x, y, okB := parse(previous)
	if !okA || !okB {
		return candidate != previous
	}
	return a > x || a == x && b > y
}
