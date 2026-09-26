package room

import "messenger/ws/internal/protocol"

func (r *Rooms) dispatch(room string, event protocol.Event) {
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
	epochChanged := entry.epoch != event.Epoch
	needsRecovery := entry.epoch != "" && epochChanged
	if epochChanged || streamAfter(event.StreamID, entry.lastID) {
		entry.lastID = event.StreamID
	}
	entry.epoch = event.Epoch
	recipients := make([]target, 0, len(entry.members))
	for connection, member := range entry.members {
		ids := make([]string, 0, len(member.conversationIDs))
		for id := range member.conversationIDs {
			if id != "" {
				ids = append(ids, id)
			}
		}
		recipients = append(recipients, target{connection, member, ids})
	}
	r.mu.Unlock()
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
	ids := make([]string, 0, len(member.conversationIDs))
	for id := range member.conversationIDs {
		if id != "" {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	member.finish(connection, room, ids, replay)
}

func (r *Rooms) failMember(c Recipient, room, conversationID string) {
	r.metrics.SQLFallback.Inc()
	c.Enqueue(protocol.Event{Type: "recovery_failed", Version: 1, Room: room, ConversationID: conversationID})
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
	for c, m := range entry.members {
		for id := range m.conversationIDs {
			if id != "" {
				targets = append(targets, target{c, id})
			}
		}
	}
	r.mu.Unlock()
	for _, target := range targets {
		r.failMember(target.c, room, target.id)
	}
}
