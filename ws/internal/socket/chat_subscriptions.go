package socket

import (
	"time"

	"messenger/ws/internal/config"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/roomname"
)

type chatSubscriptions struct {
	connection       *Connection
	config           config.Config
	groupAuth        GroupAuthorizer
	subscribeLimiter SubscriptionLimiter
	groupAuthSlots   chan struct{}
	roomCoordinator  RoomCoordinator
	metrics          *monitoring.Metrics
	rooms            map[string]string
	groups           map[string]*groupGrant
	leases           map[string]groupLease
	leaseSerial      uint64
}

type groupGrant struct {
	connection *Connection
	chatID     string
	authorized bool
	missed     bool
}

type groupLease struct {
	serial uint64
	timer  *time.Timer
}

func newChatSubscriptions(connection *Connection) *chatSubscriptions {
	server := connection.server
	return &chatSubscriptions{
		connection: connection, config: server.config, groupAuth: server.groupAuth,
		subscribeLimiter: server.subscribeLimiter, groupAuthSlots: server.groupAuthSlots,
		roomCoordinator: server.rooms, metrics: server.metrics,
		rooms: make(map[string]string), groups: make(map[string]*groupGrant), leases: make(map[string]groupLease),
	}
}

func (subscriptions *chatSubscriptions) groupGrantLocked(chatID string) *groupGrant {
	grant := subscriptions.groups[chatID]
	if grant == nil || !grant.authorized || subscriptions.connection.admissionError() != nil {
		return nil
	}
	return grant
}

func (subscriptions *chatSubscriptions) closeLocked() []*groupGrant {
	grants := make([]*groupGrant, 0, len(subscriptions.groups))
	for _, grant := range subscriptions.groups {
		grants = append(grants, grant)
	}
	for _, lease := range subscriptions.leases {
		lease.timer.Stop()
	}
	clear(subscriptions.leases)
	clear(subscriptions.groups)
	return grants
}

func (subscriptions *chatSubscriptions) revoke(chatID string) {
	subscriptions.revokeGrant(chatID, nil)
}

func (subscriptions *chatSubscriptions) revokeGrant(chatID string, expected *groupGrant) {
	connection := subscriptions.connection
	connection.mu.Lock()
	if expected != nil && subscriptions.groups[chatID] != expected {
		connection.mu.Unlock()
		return
	}
	room, grant := subscriptions.removeLocked(chatID)
	connection.mu.Unlock()
	if room != "" {
		subscriptions.roomCoordinator.LeaveChat(subscriptions.recipient(grant), room, chatID)
	}
}

func (subscriptions *chatSubscriptions) beginGroupAuthorization(chatID string) *groupGrant {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	grant := subscriptions.groups[chatID]
	if grant == nil {
		grant = &groupGrant{connection: connection, chatID: chatID}
		subscriptions.groups[chatID] = grant
	}
	return grant
}

func (subscriptions *chatSubscriptions) finishGroupAuthorizations(grants map[string]*groupGrant) {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	for chatID, grant := range grants {
		if subscriptions.groups[chatID] == grant && subscriptions.rooms[chatID] != roomname.Group(chatID) {
			delete(subscriptions.groups, chatID)
		}
	}
}

func (subscriptions *chatSubscriptions) allowGroupJoin(chatID string, grant *groupGrant) bool {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if grant == nil || subscriptions.groups[chatID] != grant || connection.closed || connection.admissionError() != nil {
		return false
	}
	return true
}

func (subscriptions *chatSubscriptions) commitGroupJoin(chatID, room string, grant *groupGrant) bool {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if grant == nil || subscriptions.groups[chatID] != grant || connection.closed || connection.admissionError() != nil {
		return false
	}
	grant.authorized = true
	subscriptions.rooms[chatID] = room
	subscriptions.renewGroupLocked(chatID)
	return true
}

func (subscriptions *chatSubscriptions) groupJoinMissed(chatID string, grant *groupGrant) bool {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return subscriptions.groups[chatID] == grant && grant.missed
}

func (subscriptions *chatSubscriptions) setDirectRoom(chatID, room string) bool {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if connection.closed {
		return false
	}
	subscriptions.rooms[chatID] = room
	return true
}

func (subscriptions *chatSubscriptions) room(chatID string) string {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return subscriptions.rooms[chatID]
}

func (subscriptions *chatSubscriptions) count() int {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	return len(subscriptions.rooms)
}

func (subscriptions *chatSubscriptions) removeLocked(chatID string) (string, *groupGrant) {
	room := subscriptions.rooms[chatID]
	grant := subscriptions.groups[chatID]
	if !roomname.IsGroup(room) {
		grant = nil
	}
	delete(subscriptions.rooms, chatID)
	delete(subscriptions.groups, chatID)
	if lease, ok := subscriptions.leases[chatID]; ok {
		lease.timer.Stop()
		delete(subscriptions.leases, chatID)
	}
	return room, grant
}

func (subscriptions *chatSubscriptions) leave(chatID string) {
	connection := subscriptions.connection
	connection.mu.Lock()
	room, grant := subscriptions.removeLocked(chatID)
	connection.mu.Unlock()
	if room != "" {
		subscriptions.roomCoordinator.LeaveChat(subscriptions.recipient(grant), room, chatID)
	}
}

func (subscriptions *chatSubscriptions) renewGroupLocked(chatID string) {
	if prior, ok := subscriptions.leases[chatID]; ok {
		prior.timer.Stop()
	}
	subscriptions.leaseSerial++
	serial := subscriptions.leaseSerial
	subscriptions.leases[chatID] = groupLease{serial: serial, timer: time.AfterFunc(subscriptions.config.GroupLease, func() {
		subscriptions.expireGroup(chatID, serial)
	})}
}

func (subscriptions *chatSubscriptions) expireGroup(chatID string, serial uint64) {
	connection := subscriptions.connection
	connection.mu.Lock()
	lease, ok := subscriptions.leases[chatID]
	if !ok || lease.serial != serial || connection.closed {
		connection.mu.Unlock()
		return
	}
	room, grant := subscriptions.removeLocked(chatID)
	connection.mu.Unlock()
	if room != "" {
		subscriptions.roomCoordinator.LeaveChat(subscriptions.recipient(grant), room, chatID)
	}
	subscriptions.metrics.GroupLeaseExpired.Inc()
	connection.Enqueue(protocol.Event{Type: protocol.EventSubscriptionExpired, Version: 1, ChatID: chatID})
}

func (subscriptions *chatSubscriptions) recipient(grant *groupGrant) roomregistry.Recipient {
	if grant != nil {
		return grant
	}
	return subscriptions.connection
}

func (grant *groupGrant) Enqueue(event protocol.Event) bool {
	frame, err := protocol.NewEventFrame(event)
	if err != nil {
		return false
	}
	return grant.EnqueueFrame(frame)
}

func (grant *groupGrant) EnqueueFrame(frame *protocol.EventFrame) bool {
	return grant.connection.enqueueFrame(frame, frameGrants{group: grant})
}

func (grant *groupGrant) Close() {
	connection := grant.connection
	connection.mu.Lock()
	if connection.closed || connection.subscriptions.groups[grant.chatID] != grant {
		connection.mu.Unlock()
		return
	}
	connection.closed = true
	connection.mu.Unlock()
	connection.Close()
}
