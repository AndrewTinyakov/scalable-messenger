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

type memberState uint32

const (
	memberCatchingUp memberState = iota
	memberLive
	memberLeft
)

type roomMember struct {
	chatIDs     map[string]bool
	state       atomic.Uint32
	joinMu      sync.Mutex
	deliveryMu  sync.Mutex
	buffer      []*protocol.EventFrame
	bufferBytes int
}

func newRoomMember() *roomMember {
	m := &roomMember{chatIDs: make(map[string]bool)}
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
	if m.hasLeft() {
		return false
	}
	if m.isCatchingUp() {
		if len(m.buffer) >= limit || m.bufferBytes+frame.Size() > byteLimit {
			m.buffer = nil
			m.bufferBytes = 0
			m.finishCatchup()
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
	if m.hasLeft() {
		return
	}
	seen := make(map[string]bool, len(replay))
	for _, event := range replay {
		if event.EventID != "" {
			seen[event.EventID] = true
		}
	}
	for _, frame := range m.buffer {
		if m.hasLeft() {
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
		if m.hasLeft() {
			break
		}
		sink.Enqueue(protocol.Event{Type: protocol.EventSubscribed, Version: 1, Room: room, ChatID: id})
	}
	m.finishCatchup()
}

func (m *roomMember) hasLeft() bool {
	return memberState(m.state.Load()) == memberLeft
}

func (m *roomMember) isCatchingUp() bool {
	return memberState(m.state.Load()) == memberCatchingUp
}

func (m *roomMember) beginCatchup() {
	m.state.CompareAndSwap(uint32(memberLive), uint32(memberCatchingUp))
}

func (m *roomMember) finishCatchup() {
	m.state.CompareAndSwap(uint32(memberCatchingUp), uint32(memberLive))
}

func (m *roomMember) leave() {
	m.state.Store(uint32(memberLeft))
}
