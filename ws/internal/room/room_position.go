package room

import (
	"context"
	"math/rand/v2"
	"strconv"
	"strings"
	"time"
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
	ticker := time.NewTicker(r.checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.checkAll(ctx)
		}
	}
}

func (r *Rooms) checkAll(ctx context.Context) {
	r.mu.Lock()
	names := make([]string, 0, len(r.rooms))
	for name := range r.rooms {
		names = append(names, name)
	}
	r.mu.Unlock()
	for _, name := range names {
		checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		epoch, last, err := r.redis.Tail(checkCtx, name)
		cancel()
		if err != nil {
			r.failRoom(name)
			continue
		}
		r.mu.Lock()
		entry := r.rooms[name]
		if entry == nil {
			r.mu.Unlock()
			continue
		}
		oldEpoch, oldLast := entry.epoch, entry.lastID
		r.mu.Unlock()
		if oldEpoch != "" && epoch != oldEpoch {
			r.failRoom(name)
			r.setPosition(name, epoch, last)
			continue
		}
		if oldLast == "" && last != "" {
			r.failRoom(name)
			r.setPosition(name, epoch, last)
			continue
		}
		if oldLast != "" && last != oldLast {
			checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			items, replayErr := r.redis.Replay(checkCtx, name, oldEpoch, oldLast, r.replayLimit)
			cancel()
			if replayErr != nil {
				r.failRoom(name)
				r.setPosition(name, epoch, last)
				continue
			}
			for _, item := range items {
				r.dispatch(name, item.Event)
			}
		}
	}
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
