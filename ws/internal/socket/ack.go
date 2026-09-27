package socket

import (
	"errors"
	"strconv"
	"sync"
	"time"

	"messenger/ws/internal/protocol"
)

var errPendingACKLimit = errors.New("pending ACK limit reached")
var errInvalidACK = errors.New("invalid message acknowledgement")

// ackTracker records frames offered to the socket writer, not Redis positions.
// A received_message frame clears only that live notification. Applied frames
// record device application, and dismissed frames resolve a skipped interval.
type ackTracker struct {
	mu            sync.Mutex
	deadline      time.Duration
	limit         int
	positionLimit int
	pending       map[string]map[uint64]time.Time
	applied       map[string]uint64
	dismissed     map[string]uint64
	positionChats map[string]struct{}
	count         int
}

func newACKTracker(limit int, deadline time.Duration) *ackTracker {
	return &ackTracker{limit: limit, deadline: deadline, positionLimit: max(512, limit*2), pending: make(map[string]map[uint64]time.Time), applied: make(map[string]uint64), dismissed: make(map[string]uint64), positionChats: make(map[string]struct{})}
}

func (tracker *ackTracker) markSent(event protocol.Event, now time.Time) error {
	if event.Type != "message_saved" {
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
	positions := tracker.pending[event.ChatID]
	if _, exists := positions[sequence]; exists {
		return nil
	}
	if tracker.count >= tracker.limit {
		return errPendingACKLimit
	}
	if positions == nil {
		positions = make(map[uint64]time.Time)
		tracker.pending[event.ChatID] = positions
	}
	positions[sequence] = now.Add(tracker.deadline)
	tracker.count++
	return nil
}

func (tracker *ackTracker) apply(chatID, sequenceText string) error {
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || chatID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if !tracker.claimPosition(chatID) {
		return errInvalidACK
	}
	if sequence > tracker.applied[chatID] {
		tracker.applied[chatID] = sequence
	}
	tracker.resolvePending(chatID, sequence)
	return nil
}

func (tracker *ackTracker) dismiss(chatID, sequenceText string) error {
	sequence, err := strconv.ParseUint(sequenceText, 10, 64)
	if err != nil || sequence == 0 || chatID == "" {
		return errInvalidACK
	}
	tracker.mu.Lock()
	defer tracker.mu.Unlock()
	if !tracker.claimPosition(chatID) {
		return errInvalidACK
	}
	if sequence > tracker.dismissed[chatID] {
		tracker.dismissed[chatID] = sequence
	}
	tracker.resolvePending(chatID, sequence)
	return nil
}

// Caller holds tracker.mu. Arbitrary client chat IDs must not grow the
// per-connection cursor maps without bound.
func (tracker *ackTracker) claimPosition(chatID string) bool {
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
		delete(positions, sequence)
		tracker.count--
		if len(positions) == 0 {
			delete(tracker.pending, chatID)
		}
	}
	return nil
}

// Caller holds tracker.mu.
func (tracker *ackTracker) resolvePending(chatID string, sequence uint64) {
	positions := tracker.pending[chatID]
	for pending := range positions {
		if pending <= sequence {
			delete(positions, pending)
			tracker.count--
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
		for _, deadline := range positions {
			if !now.Before(deadline) {
				chats = append(chats, chatID)
				break
			}
		}
	}
	return chats
}
