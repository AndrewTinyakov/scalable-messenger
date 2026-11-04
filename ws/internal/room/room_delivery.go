package room

import (
	"sync"
	"sync/atomic"

	"messenger/ws/internal/protocol"
)

type Recipient interface{ Enqueue(protocol.Event) bool }

type frameRecipient interface {
	EnqueueFrame(*protocol.EventFrame) bool
}

func enqueueFrame(sink Recipient, frame *protocol.EventFrame) bool {
	if recipient, ok := sink.(frameRecipient); ok {
		return recipient.EnqueueFrame(frame)
	}
	return sink.Enqueue(frame.Event())
}

type roomMember struct {
	chatIDs     map[string]bool
	catching    atomic.Bool
	left        atomic.Bool
	joinMu      sync.Mutex
	deliveryMu  sync.Mutex
	buffer      []*protocol.EventFrame
	bufferBytes int
}

func newRoomMember() *roomMember {
	m := &roomMember{chatIDs: make(map[string]bool)}
	m.catching.Store(true)
	return m
}

func (m *roomMember) deliver(sink Recipient, event protocol.Event, limit, byteLimit int) bool {
	frame, err := protocol.NewEventFrame(event)
	if err != nil {
		return true
	}
	return m.deliverFrame(sink, frame, limit, byteLimit)
}

func (m *roomMember) deliverFrame(sink Recipient, frame *protocol.EventFrame, limit, byteLimit int) bool {
	m.deliveryMu.Lock()
	defer m.deliveryMu.Unlock()
	if m.left.Load() {
		return false
	}
	if m.catching.Load() {
		if len(m.buffer) >= limit || m.bufferBytes+frame.Size() > byteLimit {
			m.buffer = nil
			m.bufferBytes = 0
			m.catching.Store(false)
			return true
		}
		m.buffer = append(m.buffer, frame)
		m.bufferBytes += frame.Size()
		return false
	}
	enqueueFrame(sink, frame)
	return false
}

func (m *roomMember) finish(sink Recipient, room string, ids []string, replay []protocol.Event) {
	m.deliveryMu.Lock()
	defer m.deliveryMu.Unlock()
	if m.left.Load() {
		return
	}
	seen := make(map[string]bool, len(replay))
	for _, event := range replay {
		if event.EventID != "" {
			seen[event.EventID] = true
		}
	}
	for _, frame := range m.buffer {
		if m.left.Load() {
			break
		}
		event := frame.Event()
		if event.EventID == "" || !seen[event.EventID] {
			enqueueFrame(sink, frame)
		}
	}
	m.buffer = nil
	m.bufferBytes = 0
	for _, id := range ids {
		if m.left.Load() {
			break
		}
		sink.Enqueue(protocol.Event{Type: protocol.EventSubscribed, Version: 1, Room: room, ChatID: id})
	}
	m.catching.Store(false)
}
