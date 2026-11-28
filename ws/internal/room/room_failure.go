package room

import (
	"sync"
	"time"

	"messenger/ws/internal/monitoring"
)

const staleRoomLogInterval = 30 * time.Second

type staleRoomLogLimiter struct {
	mu         sync.Mutex
	next       map[monitoring.RoomFailureReason]time.Time
	suppressed map[monitoring.RoomFailureReason]int
}

func (l *staleRoomLogLimiter) allow(reason monitoring.RoomFailureReason, now time.Time) (bool, int) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.next == nil {
		l.next = make(map[monitoring.RoomFailureReason]time.Time)
		l.suppressed = make(map[monitoring.RoomFailureReason]int)
	}
	if now.Before(l.next[reason]) {
		l.suppressed[reason]++
		return false, 0
	}
	suppressed := l.suppressed[reason]
	delete(l.suppressed, reason)
	l.next[reason] = now.Add(staleRoomLogInterval)
	return true, suppressed
}

func (r *Rooms) recordStaleRoom(name string, reason monitoring.RoomFailureReason, recipients int, cause error) {
	r.metrics.RecordStaleRoom(reason)
	allowed, suppressed := r.staleLog.allow(reason, time.Now())
	if !allowed {
		return
	}
	attributes := []any{"room", name, "reason", string(reason), "recipients", recipients, "suppressed", suppressed}
	if cause != nil {
		attributes = append(attributes, "error", cause)
	}
	r.logger.Warn("room feed stale; members sent to recovery", attributes...)
}
