package room

import (
	"time"

	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
)

type roomTarget struct {
	connection Recipient
	member     *roomMember
	ids        []string
}

func (entry *localRoom) targetsLocked(includeChatIDs bool) []roomTarget {
	recipients := make([]roomTarget, 0, len(entry.members))
	for connection, member := range entry.members {
		var ids []string
		if includeChatIDs {
			ids = make([]string, 0, len(member.chatIDs))
			for id := range member.chatIDs {
				if id != "" {
					ids = append(ids, id)
				}
			}
		}
		recipients = append(recipients, roomTarget{connection, member, ids})
	}
	return recipients
}

func (r *Rooms) dispatch(name string, event protocol.Event) {
	if entry := r.lookup(name); entry != nil {
		r.dispatchRoom(entry, event)
	}
}

func (r *Rooms) dispatchRoom(entry *localRoom, event protocol.Event) int {
	started := time.Now()
	entry.mu.Lock()
	if entry.state == roomRetired || (entry.epoch == event.Epoch && entry.lastID != "" && !streamAfter(event.StreamID, entry.lastID)) {
		entry.mu.Unlock()
		return 0
	}
	epochChanged := entry.epoch != event.Epoch
	needsRecovery := entry.epoch != "" && epochChanged
	if epochChanged || streamAfter(event.StreamID, entry.lastID) {
		entry.lastID = event.StreamID
	}
	entry.epoch = event.Epoch
	entry.lastLiveAt = time.Now()
	recipients := entry.targetsLocked(needsRecovery)
	entry.mu.Unlock()
	frame, err := protocol.NewEventFrame(event)
	if err != nil {
		r.failRoomEntry(entry)
		return 0
	}
	r.metrics.FanoutRecipients.Observe(float64(len(recipients)))
	for _, recipient := range recipients {
		if recipient.member.hasLeft() {
			continue
		}
		if needsRecovery {
			closed := r.failRecipient(recipient.connection, entry.name, recipient.ids)
			if closed || roomname.IsUser(entry.name) {
				continue
			}
		}
		if recipient.member.deliverFrame(recipient.connection, frame, r.bufferLimit, r.bufferBytes) {
			entry.mu.Lock()
			ids := make([]string, 0, len(recipient.member.chatIDs))
			for id := range recipient.member.chatIDs {
				if id != "" {
					ids = append(ids, id)
				}
			}
			entry.mu.Unlock()
			r.failRecipient(recipient.connection, entry.name, ids)
		}
	}
	r.metrics.FanoutSeconds.Observe(time.Since(started).Seconds())
	return frame.Size()
}

func (r *Rooms) finishMember(connection Recipient, entry *localRoom, member *roomMember, replay []protocol.Event) {
	entry.mu.Lock()
	if entry.state == roomRetired || entry.members[connection] != member {
		entry.mu.Unlock()
		return
	}
	ids := make([]string, 0, len(member.chatIDs))
	for id := range member.chatIDs {
		if id != "" {
			ids = append(ids, id)
		}
	}
	entry.mu.Unlock()
	member.finish(connection, entry.name, ids, replay)
}

func (r *Rooms) failMember(c Recipient, name, chatID string) {
	r.metrics.SQLFallback.Inc()
	c.Enqueue(protocol.Event{Type: protocol.EventRecoveryFailed, Version: 1, Room: name, ChatID: chatID})
}

func (r *Rooms) failRecipient(c Recipient, name string, chatIDs []string) bool {
	if connection, ok := c.(interface{ Close() }); ok {
		connection.Close()
		return true
	}
	for _, chatID := range chatIDs {
		r.failMember(c, name, chatID)
	}
	return false
}

func (r *Rooms) failRoom(name string) {
	if entry := r.lookup(name); entry != nil {
		r.failRoomEntry(entry)
	}
}

func (r *Rooms) failRoomEntry(entry *localRoom) {
	entry.mu.Lock()
	if entry.state == roomRetired {
		entry.mu.Unlock()
		return
	}
	targets := entry.targetsLocked(true)
	entry.mu.Unlock()
	r.metrics.StaleRooms.Inc()
	for _, target := range targets {
		if !target.member.hasLeft() {
			r.failRecipient(target.connection, entry.name, target.ids)
		}
	}
}
