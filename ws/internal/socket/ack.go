package socket

import (
	"errors"
	"strconv"
	"sync"
	"time"

	"messenger/ws/internal/protocol"
)

var errPendingACKLimit = errors.New("pending ACK limit reached")
var errInvalidACK = errors.New("invalid applied sequence")

// ackTracker records frames offered to the socket writer, not Redis positions.
// Applied frames are cumulative per conversation and never prove another device applied a message.
type ackTracker struct {
	mu       sync.Mutex
	deadline time.Duration
	limit    int
	pending  map[string]map[uint64]time.Time
	applied  map[string]uint64
	count    int
}

func newACKTracker(limit int, deadline time.Duration) *ackTracker {
	return &ackTracker{limit: limit, deadline: deadline, pending: make(map[string]map[uint64]time.Time), applied: make(map[string]uint64)}
}

func (tracker *ackTracker) markSent(event protocol.Event, now time.Time) error {
	if event.Type != "message_saved" {
		return nil
	}
	sequence, err := strconv.ParseUint(event.Sequence, 10, 64)
	if err != nil || sequence == 0 || event.ConversationID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	positions := tracker.pending[event.ConversationID]
	if _, exists := positions[sequence]; exists {
		return nil
	}
	if tracker.count >= tracker.limit {
		return errPendingACKLimit
	}
	if positions == nil {
		positions = make(map[uint64]time.Time)
		tracker.pending[event.ConversationID] = positions
	}
	positions[sequence] = now.Add(tracker.deadline)
	tracker.count++
	return nil
}

func (tracker *ackTracker) apply(conversationID, sequenceText string) error {
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || conversationID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if sequence > tracker.applied[conversationID] {
		tracker.applied[conversationID] = sequence
	}
	positions := tracker.pending[conversationID]
	for pending := range positions {
		if pending <= sequence {
			delete(positions, pending)
			tracker.count--
		}
	}
	if len(positions) == 0 {
		delete(tracker.pending, conversationID)
	}
	return nil
}

func (tracker *ackTracker) expired(now time.Time) []string {
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	var conversations []string
	for conversationID, positions := range tracker.pending {
		for _, deadline := range positions {
			if !now.Before(deadline) {
				conversations = append(conversations, conversationID)
				break
			}
		}
	}
	return conversations
}
