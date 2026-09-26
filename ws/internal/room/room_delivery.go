package room

import (
	"sync"
	"sync/atomic"

	"messenger/ws/internal/protocol"
)

type Recipient interface{ Enqueue(protocol.Event) bool }

// Room membership is guarded by Rooms.mu. Delivery state has its own lock so a
// replay drain cannot be overtaken by a live fanout after the registry lock is released.
type roomMember struct {
	conversationIDs map[string]bool
	catching        atomic.Bool
	deliveryMu      sync.Mutex
	buffer          []protocol.Event
}

func newRoomMember() *roomMember {
	m := &roomMember{conversationIDs: make(map[string]bool)}
	m.catching.Store(true)
	return m
}

func (m *roomMember) deliver(sink Recipient, event protocol.Event, limit int) bool {
	m.deliveryMu.Lock()
	defer m.deliveryMu.Unlock()
	if m.catching.Load() {
		if len(m.buffer) >= limit {
			m.buffer = nil
			m.catching.Store(false)
			return true
		}
		m.buffer = append(m.buffer, event)
		return false
	}
	sink.Enqueue(event)
	return false
}

func (m *roomMember) finish(sink Recipient, room string, ids []string, replay []protocol.Event) {
	m.deliveryMu.Lock()
	defer m.deliveryMu.Unlock()
	seen := make(map[string]bool, len(replay))
	for _, event := range replay {
		if event.EventID != "" {
			seen[event.EventID] = true
		}
	}
	for _, event := range m.buffer {
		if event.EventID == "" || !seen[event.EventID] {
			sink.Enqueue(event)
		}
	}
	m.buffer = nil
	for _, id := range ids {
		sink.Enqueue(protocol.Event{Type: "subscribed", Version: 1, Room: room, ConversationID: id})
	}
	m.catching.Store(false)
}
