package room

import (
	"context"
	"errors"
	"math/rand/v2"
	"strconv"
	"strings"
	"sync"
	"time"

	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type batchPositionReader interface {
	TailBatch(context.Context, []string) (map[string]redisroom.Position, error)
}

type positionCandidate struct {
	entry      *localRoom
	epoch      string
	last       string
	lastLiveAt time.Time
}

func (r *Rooms) RunChecks(ctx context.Context) {
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
			if remaining := r.checkInterval - time.Since(started); remaining > pause {
				pause = remaining
			}
			timer.Reset(pause)
		}
	}
}

func (r *Rooms) snapshotRooms() []*localRoom {
	r.mu.Lock()
	entries := make([]*localRoom, 0, len(r.rooms))
	for _, entry := range r.rooms {
		entries = append(entries, entry)
	}
	r.mu.Unlock()
	return entries
}

func (r *Rooms) checkAll(ctx context.Context) {
	started := time.Now()
	defer func() {
		r.metrics.PositionSweep.Observe(time.Since(started).Seconds())
		oldest := 0.0
		for _, entry := range r.snapshotRooms() {
			entry.mu.Lock()
			positionAt := entry.lastPositionAt
			if entry.lastLiveAt.After(positionAt) {
				positionAt = entry.lastLiveAt
			}
			retired := entry.state == roomRetired
			entry.mu.Unlock()
			if !retired {
				oldest = max(oldest, time.Since(positionAt).Seconds())
			}
		}
		r.metrics.OldestPositionAge.Set(oldest)
	}()
	entries := r.snapshotRooms()
	candidates := make([]positionCandidate, 0, len(entries))
	for _, entry := range entries {
		if candidate, ok := r.quietPosition(entry); ok {
			candidates = append(candidates, candidate)
		}
	}
	if len(candidates) == 0 {
		return
	}
	batchSize := 1
	if _, ok := r.redis.(batchPositionReader); ok {
		batchSize = 128
	}
	batchCount := (len(candidates) + batchSize - 1) / batchSize
	jobs := make(chan []positionCandidate)
	var workers sync.WaitGroup
	for range min(16, batchCount) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for batch := range jobs {
				r.checkPositions(ctx, batch)
			}
		}()
	}
	for offset := 0; offset < len(candidates); offset += batchSize {
		select {
		case jobs <- candidates[offset:min(offset+batchSize, len(candidates))]:
		case <-ctx.Done():
			close(jobs)
			workers.Wait()
			return
		}
	}
	close(jobs)
	workers.Wait()
}

func (r *Rooms) quietPosition(entry *localRoom) (positionCandidate, bool) {
	select {
	case <-entry.ready:
	default:
		return positionCandidate{}, false
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.state == roomRetired || entry.err != nil || (r.checkInterval > 0 && time.Since(entry.lastLiveAt) < r.checkInterval) {
		return positionCandidate{}, false
	}
	return positionCandidate{entry: entry, epoch: entry.epoch, last: entry.lastID, lastLiveAt: entry.lastLiveAt}, true
}

func (r *Rooms) checkPositions(ctx context.Context, candidates []positionCandidate) {
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	defer cancel()
	if batch, ok := r.redis.(batchPositionReader); ok {
		names := make([]string, len(candidates))
		for index, candidate := range candidates {
			names[index] = candidate.entry.name
		}
		positions, err := batch.TailBatch(checkCtx, names)
		if ctx.Err() != nil {
			return
		}
		for _, candidate := range candidates {
			position, exists := positions[candidate.entry.name]
			if !exists {
				position.Err = err
				if position.Err == nil {
					position.Err = errors.New("room position missing from batch")
				}
			}
			r.applyPosition(ctx, candidate, position)
		}
		return
	}
	for _, candidate := range candidates {
		epoch, last, err := r.redis.Tail(checkCtx, candidate.entry.name)
		if ctx.Err() != nil {
			return
		}
		r.applyPosition(ctx, candidate, redisroom.Position{Epoch: epoch, StreamID: last, Err: err})
	}
}

func (r *Rooms) applyPosition(ctx context.Context, candidate positionCandidate, position redisroom.Position) {
	entry := candidate.entry
	entry.positionMu.Lock()
	defer entry.positionMu.Unlock()
	entry.mu.Lock()
	if entry.state == roomRetired || entry.epoch != candidate.epoch || entry.lastID != candidate.last || !entry.lastLiveAt.Equal(candidate.lastLiveAt) {
		entry.mu.Unlock()
		return
	}
	if position.Err == nil {
		entry.lastPositionAt = time.Now()
	}
	entry.mu.Unlock()
	if position.Err != nil {
		r.failRoomEntry(entry)
		return
	}
	r.reconcileRoomPosition(ctx, entry, candidate.epoch, candidate.last, position.Epoch, position.StreamID)
}

func (r *Rooms) roomPosition(name string) (*localRoom, string, string) {
	entry := r.lookup(name)
	if entry == nil {
		return nil, "", ""
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	if entry.state == roomRetired {
		return nil, "", ""
	}
	return entry, entry.epoch, entry.lastID
}

func (r *Rooms) handleLive(ctx context.Context, name string, live redisroom.Live) {
	if entry := r.lookup(name); entry != nil {
		r.handleLiveRoom(ctx, entry, live)
	}
}

func (r *Rooms) handleLiveRoom(ctx context.Context, entry *localRoom, live redisroom.Live) {
	if live.Event.Type == protocol.EventMessageSaved && live.Event.CreatedAt != "" {
		if created, err := time.Parse(time.RFC3339Nano, live.Event.CreatedAt); err == nil {
			r.metrics.SavedEventLag.Observe(max(0, time.Since(created).Seconds()))
		}
	}
	entry.positionMu.Lock()
	defer entry.positionMu.Unlock()
	entry.mu.Lock()
	oldEpoch, oldLast, retired := entry.epoch, entry.lastID, entry.state == roomRetired
	entry.mu.Unlock()
	if retired {
		return
	}
	if oldEpoch == live.Epoch {
		if oldLast != "" && !streamAfter(live.StreamID, oldLast) {
			return
		}
		if oldLast != "" && (!live.HasPrevious || live.PreviousStreamID != oldLast) {
			r.reconcileRoomPosition(ctx, entry, oldEpoch, oldLast, live.Epoch, live.StreamID)
			return
		}
		if oldLast == "" && live.HasPrevious && live.PreviousStreamID != "" {
			r.reconcileRoomPosition(ctx, entry, oldEpoch, oldLast, live.Epoch, live.StreamID)
			return
		}
	}
	r.dispatchRoom(entry, live.Event)
}

func (r *Rooms) reconcileRoomPosition(ctx context.Context, entry *localRoom, oldEpoch, oldLast, epoch, last string) {
	if oldEpoch == epoch && oldLast == last {
		return
	}
	if oldEpoch == epoch && oldLast != "" && last != "" && r.replayRoomThrough(ctx, entry, oldEpoch, oldLast, last) {
		return
	}
	r.failRoomEntry(entry)
	r.setRoomPosition(entry, epoch, last)
}

func (r *Rooms) replayRoomThrough(ctx context.Context, entry *localRoom, epoch, after, through string) bool {
	checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
	items, err := r.replay(checkCtx, entry.name, epoch, after, through, "continuity")
	cancel()
	if err != nil {
		return false
	}

	for _, item := range items {
		if size := r.dispatchRoom(entry, item.Event); size > 0 {
			r.metrics.ContinuityReplayEvents.Inc()
			r.metrics.ContinuityReplayBytes.Add(float64(size))
		}
	}
	return true
}

func (r *Rooms) replay(ctx context.Context, name, epoch, after, through, trigger string) (items []redisroom.Live, replayErr error) {
	started := time.Now()
	defer func() {
		result := "complete"
		switch {
		case errors.Is(replayErr, redisroom.ErrGap):
			result = "gap"
		case errors.Is(replayErr, context.Canceled), errors.Is(replayErr, context.DeadlineExceeded):
			result = "cancelled"
		case replayErr != nil:
			result = "failed"
		}
		r.metrics.ReplaySeconds.WithLabelValues(trigger, result).Observe(time.Since(started).Seconds())
	}()
	items, replayErr = r.redis.Replay(ctx, name, epoch, after, r.replayLimit)
	if replayErr != nil {
		return nil, replayErr
	}
	if through == "" {
		return coalesceHistoryHints(items), nil
	}
	for _, item := range items {
		if item.StreamID == through {
			return coalesceHistoryHints(items), nil
		}
	}
	return nil, redisroom.ErrGap
}

func (r *Rooms) setRoomPosition(entry *localRoom, epoch, last string) {
	entry.mu.Lock()
	if entry.state != roomRetired {
		entry.epoch, entry.lastID = epoch, last
	}
	entry.mu.Unlock()
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
