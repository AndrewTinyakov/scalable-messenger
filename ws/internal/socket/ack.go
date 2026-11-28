package socket

import (
	"container/heap"
	"errors"
	"strconv"
	"sync"
	"time"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
)

var errPendingACKLimit = errors.New("pending ACK limit reached")
var errInvalidACK = errors.New("invalid message acknowledgement")

type ackTracker struct {
	state         lifecycleState
	metrics       *monitoring.Metrics
	mu            sync.Mutex
	deadline      time.Duration
	limit         int
	positionLimit int
	pending       map[string]map[uint64]*ackDeadline
	deadlines     ackDeadlines
	changed       chan struct{}
	applied       map[string]uint64
	dismissed     map[string]uint64
	positionChats map[string]struct{}
	count         int
}

func newACKTracker(limit int, deadline time.Duration) *ackTracker {
	return &ackTracker{limit: limit, deadline: deadline, positionLimit: max(512, limit*2), pending: make(map[string]map[uint64]*ackDeadline), changed: make(chan struct{}, 1), applied: make(map[string]uint64), dismissed: make(map[string]uint64), positionChats: make(map[string]struct{})}
}

func (tracker *ackTracker) markSent(event protocol.Event, now time.Time) error {
	if event.Type != protocol.EventMessageSaved {
		return nil
	}
	sequence, err := strconv.ParseUint(event.Sequence, 10, 64)
	if err != nil || sequence == 0 || event.ChatID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if sequence <= tracker.applied[event.ChatID] || sequence <= tracker.dismissed[event.ChatID] {
		return nil
	}
	if tracker.state == lifecycleClosed {
		return errInvalidACK
	}
	positions := tracker.pending[event.ChatID]
	if _, exists := positions[sequence]; exists {
		return nil
	}
	if tracker.count >= tracker.limit {
		return errPendingACKLimit
	}
	if positions == nil {
		positions = make(map[uint64]*ackDeadline)
		tracker.pending[event.ChatID] = positions
	}
	saved, _ := time.Parse(time.RFC3339Nano, event.CreatedAt)
	entry := &ackDeadline{deadline: now.Add(tracker.deadline), offered: now, saved: saved}
	positions[sequence] = entry
	heap.Push(&tracker.deadlines, entry)
	tracker.notifyChanged()
	tracker.count++
	if tracker.metrics != nil {
		tracker.metrics.PendingACKs.Inc()
	}
	return nil
}

func (tracker *ackTracker) apply(chatID, sequenceText string) error {
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || chatID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if !tracker.claimPositionLocked(chatID) {
		return errInvalidACK
	}
	if sequence > tracker.applied[chatID] {
		tracker.applied[chatID] = sequence
	}
	tracker.resolvePendingLocked(chatID, sequence, true)
	return nil
}

func (tracker *ackTracker) dismiss(chatID, sequenceText string) error {
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || sequence == 0 || chatID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if !tracker.claimPositionLocked(chatID) {
		return errInvalidACK
	}
	if sequence > tracker.dismissed[chatID] {
		tracker.dismissed[chatID] = sequence
	}
	tracker.resolvePendingLocked(chatID, sequence, false)
	return nil
}

func (tracker *ackTracker) claimPositionLocked(chatID string) bool {
	if _, exists := tracker.positionChats[chatID]; exists {
		return true
	}
	if len(tracker.positionChats) >= tracker.positionLimit {
		for previous := range tracker.positionChats {
			if len(tracker.pending[previous]) == 0 {
				delete(tracker.positionChats, previous)
				delete(tracker.applied, previous)
				delete(tracker.dismissed, previous)
				break
			}
		}
		if len(tracker.positionChats) >= tracker.positionLimit {
			return false
		}
	}
	tracker.positionChats[chatID] = struct{}{}
	return true
}

func (tracker *ackTracker) receivedMessage(chatID, sequenceText string) error {
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || sequence == 0 || chatID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	positions := tracker.pending[chatID]
	if _, exists := positions[sequence]; exists {
		heap.Remove(&tracker.deadlines, positions[sequence].index)
		delete(positions, sequence)
		tracker.count--
		if tracker.metrics != nil {
			tracker.metrics.PendingACKs.Dec()
		}
		tracker.notifyChanged()
		if len(positions) == 0 {
			delete(tracker.pending, chatID)
		}
	}
	return nil
}

func (tracker *ackTracker) resolvePendingLocked(chatID string, sequence uint64, applied bool) {
	positions := tracker.pending[chatID]
	for pending := range positions {
		if pending <= sequence {
			if applied && tracker.metrics != nil {
				entry := positions[pending]
				tracker.metrics.ObserveApplied(entry.offered, entry.saved, time.Now())
			}
			heap.Remove(&tracker.deadlines, positions[pending].index)
			delete(positions, pending)
			tracker.count--
			if tracker.metrics != nil {
				tracker.metrics.PendingACKs.Dec()
			}
			tracker.notifyChanged()
		}
	}
	if len(positions) == 0 {
		delete(tracker.pending, chatID)
	}
}

func (tracker *ackTracker) expired(now time.Time) []string {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	var chats []string
	for chatID, positions := range tracker.pending {
		for _, entry := range positions {
			if !now.Before(entry.deadline) {
				chats = append(chats, chatID)
				break
			}
		}
	}
	return chats
}

func (tracker *ackTracker) nextDeadline() time.Time {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if len(tracker.deadlines) == 0 {
		return time.Time{}
	}
	return tracker.deadlines[0].deadline
}

func (tracker *ackTracker) notifyChanged() {
	select {
	case tracker.changed <- struct{}{}:
	default:
	}
}

type ackDeadline struct {
	deadline time.Time
	offered  time.Time
	saved    time.Time
	index    int
}

type ackDeadlines []*ackDeadline

func (entries ackDeadlines) Len() int { return len(entries) }
func (entries ackDeadlines) Less(i, j int) bool {
	return entries[i].deadline.Before(entries[j].deadline)
}
func (entries ackDeadlines) Swap(i, j int) {
	entries[i], entries[j] = entries[j], entries[i]
	entries[i].index = i
	entries[j].index = j
}
func (entries *ackDeadlines) Push(value any) {
	entry := value.(*ackDeadline)
	entry.index = len(*entries)
	*entries = append(*entries, entry)
}
func (entries *ackDeadlines) Pop() any {
	prior := *entries
	entry := prior[len(prior)-1]
	prior[len(prior)-1] = nil
	*entries = prior[:len(prior)-1]
	return entry
}

func (tracker *ackTracker) close() {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if tracker.metrics != nil {
		tracker.metrics.PendingACKs.Sub(float64(tracker.count))
	}
	tracker.state = lifecycleClosed
	tracker.count = 0
	clear(tracker.pending)
	tracker.deadlines = nil
}
