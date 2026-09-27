package room

import (
	"strings"
	"time"

	"messenger/ws/internal/protocol"
)

func (r *Rooms) dispatch(room string, event protocol.Event) {
	started := time.Now()
	type target struct {
		connection Recipient
		member     *roomMember
		ids        []string
	}
	r.mu.Lock()
	entry := r.rooms[room]
	if entry == nil {
		r.mu.Unlock()
		return
	}
	if entry.epoch == event.Epoch && entry.lastID != "" && !streamAfter(event.StreamID, entry.lastID) {
		r.mu.Unlock()
		return
	}
	epochChanged := entry.epoch != event.Epoch
	needsRecovery := entry.epoch != "" && epochChanged
	if epochChanged || streamAfter(event.StreamID, entry.lastID) {
		entry.lastID = event.StreamID
	}
	entry.epoch = event.Epoch
	entry.lastLiveAt = time.Now()
	recipients := make([]target, 0, len(entry.members))
	for connection, member := range entry.members {
		ids := make([]string, 0, len(member.chatIDs))
		for id := range member.chatIDs {
			if id != "" {
				ids = append(ids, id)
			}
		}
		recipients = append(recipients, target{connection, member, ids})
	}
	r.mu.Unlock()
	r.metrics.FanoutRecipients.Observe(float64(len(recipients)))
	for _, recipient := range recipients {
		if needsRecovery {
			for _, id := range recipient.ids {
				r.failMember(recipient.connection, room, id)
			}
		}
		if recipient.member.deliver(recipient.connection, event, r.bufferLimit) {
			for _, id := range recipient.ids {
				r.failMember(recipient.connection, room, id)
			}
		}
	}
	r.metrics.FanoutSeconds.Observe(time.Since(started).Seconds())
}

func (r *Rooms) finish(connection Recipient, room string, replay []protocol.Event) {
	r.mu.Lock()
	entry := r.rooms[room]
	if entry == nil {
		r.mu.Unlock()
		return
	}
	member := entry.members[connection]
	if member == nil {
		r.mu.Unlock()
		return
	}
	ids := make([]string, 0, len(member.chatIDs))
	for id := range member.chatIDs {
		if id != "" {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	member.finish(connection, room, ids, replay)
}

func (r *Rooms) failMember(c Recipient, room, chatID string) {
	r.metrics.SQLFallback.Inc()
	c.Enqueue(protocol.Event{Type: "recovery_failed", Version: 1, Room: room, ChatID: chatID})
}

func (r *Rooms) failRoom(room string) {
	r.metrics.StaleRooms.Inc()
	r.mu.Lock()
	entry := r.rooms[room]
	if entry == nil {
		r.mu.Unlock()
		return
	}
	type target struct {
		c  Recipient
		id string
	}
	var targets []target
	connections := make(map[interface{ Close() }]struct{})
	for c, m := range entry.members {
		if closer, ok := c.(interface{ Close() }); ok {
			connections[closer] = struct{}{}
		}
		for id := range m.chatIDs {
			if id != "" {
				targets = append(targets, target{c, id})
			}
		}
	}
	r.mu.Unlock()
	if strings.HasPrefix(room, "user:") {
		// A missed personal-room revocation must not leave a group subscription
		// alive indefinitely. Reconnect forces current SQL authorization.
		for connection := range connections {
			connection.Close()
		}
		return
	}
	for _, target := range targets {
		r.failMember(target.c, room, target.id)
	}
}
