package socket

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
	"messenger/ws/internal/ticket"
)

type Connection struct {
	server            *Server
	socket            *websocket.Conn
	session           ticket.Identity
	token             string
	connectionLeaseID string
	ctx               context.Context
	cancel            context.CancelFunc
	out               chan outbound
	mu                sync.Mutex
	queuedBytes       int
	closed            bool
	rooms             map[string]string
	revocations       map[string]uint64
	blocked           map[string]bool
	leases            map[string]groupLease
	leaseSerial       uint64
	acks              *ackTracker
	once              sync.Once
	expiry            *time.Timer
}

type outbound struct {
	payload []byte
	event   protocol.Event
}

type groupLease struct {
	serial uint64
	timer  *time.Timer
}

func newConnection(server *Server, socket *websocket.Conn, session ticket.Identity, token string) *Connection {
	ctx, cancel := context.WithCancel(server.ctx)
	c := &Connection{server: server, socket: socket, session: session, token: token, ctx: ctx, cancel: cancel, out: make(chan outbound, server.config.QueueItems), rooms: make(map[string]string), revocations: make(map[string]uint64), blocked: make(map[string]bool), leases: make(map[string]groupLease), acks: newACKTracker(server.config.PendingACKLimit, server.config.ACKTimeout)}
	if !session.ExpiresAt.IsZero() {
		c.expiry = time.AfterFunc(time.Until(session.ExpiresAt), c.Close)
	}
	return c
}

func (c *Connection) Enqueue(event protocol.Event) bool {
	if event.Type == "session_revoked" {
		if event.Room == "user:"+c.session.UserID && event.SessionID == c.session.SessionID {
			c.closeRevoked()
		}
		return true
	}
	if event.Type == "member_removed" {
		room := c.revokeChat(event.ChatID)
		if room != "" {
			c.server.rooms.LeaveChat(c, room, event.ChatID)
		}
	}
	if event.Version == 0 {
		event.Version = 1
	}
	data, err := json.Marshal(event)
	if err != nil {
		return false
	}
	c.mu.Lock()
	if event.Room == "group:"+event.ChatID && c.blocked[event.ChatID] {
		c.mu.Unlock()
		return true
	}
	if c.closed {
		c.mu.Unlock()
		return false
	}
	if c.queuedBytes+len(data) > c.server.config.QueueBytes {
		c.mu.Unlock()
		c.server.metrics.SlowCloses.Inc()
		c.Close()
		return false
	}
	select {
	case c.out <- outbound{payload: data, event: event}:
		c.queuedBytes += len(data)
		c.server.metrics.QueuedBytes.Add(float64(len(data)))
		c.mu.Unlock()
		return true
	default:
		c.mu.Unlock()
		c.server.metrics.SlowCloses.Inc()
		c.Close()
		return false
	}
}

func (c *Connection) closeRevoked() {
	if c.socket != nil {
		deadline := time.Now().Add(c.server.config.WriteTimeout)
		_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4003, "session_revoked"), deadline)
	}
	c.Close()
}

func (c *Connection) revokeChat(chatID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.revocations[chatID]++
	c.blocked[chatID] = true
	room := c.rooms[chatID]
	delete(c.rooms, chatID)
	if lease, ok := c.leases[chatID]; ok {
		lease.timer.Stop()
		delete(c.leases, chatID)
	}
	return room
}

func (c *Connection) revocation(chatID string) uint64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.revocations[chatID]
}

func (c *Connection) allowGroupJoin(chatID string, revision uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revocations[chatID] != revision {
		return false
	}
	delete(c.blocked, chatID)
	return true
}

func (c *Connection) commitGroupJoin(chatID, room string, revision uint64) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.revocations[chatID] != revision || c.closed {
		return false
	}
	c.rooms[chatID] = room
	c.renewGroupLocked(chatID)
	delete(c.revocations, chatID)
	return true
}

func (c *Connection) Close() {
	c.once.Do(func() {
		if c.expiry != nil {
			c.expiry.Stop()
		}
		c.mu.Lock()
		c.closed = true
		for _, lease := range c.leases {
			lease.timer.Stop()
		}
		clear(c.leases)
		c.server.metrics.QueuedBytes.Sub(float64(c.queuedBytes))
		c.queuedBytes = 0
		c.mu.Unlock()
		c.cancel()
		if c.socket != nil {
			_ = c.socket.Close()
		}
		c.server.rooms.LeaveAll(c)
		c.server.remove(c)
		c.server.releaseConnectionLease(c.session.UserID, c.connectionLeaseID)
	})
}

func (c *Connection) renewConnectionLease() {
	ticker := time.NewTicker(jitteredFirstTick(redisroom.ConnectionLeaseRenewInterval))
	defer ticker.Stop()
	steady := false
	for {
		select {
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			if !steady {
				ticker.Reset(redisroom.ConnectionLeaseRenewInterval)
				steady = true
			}
			ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
			active, err := c.server.connectionLeases.RenewConnectionLease(ctx, c.session.UserID, c.connectionLeaseID)
			cancel()
			if c.ctx.Err() != nil {
				return
			}
			if err != nil || !active {
				if err != nil && c.server.logger != nil {
					c.server.logger.Warn("renew connection lease", "error", err)
				}
				c.Close()
				return
			}
		}
	}
}

func (c *Connection) writeLoop() {
	defer c.Close()
	pingTicker := time.NewTicker(jitteredFirstTick(c.server.config.PingInterval))
	defer pingTicker.Stop()
	pingSteady := false
	ackInterval := c.server.config.ACKTimeout / 4
	if ackInterval > time.Second {
		ackInterval = time.Second
	}
	if ackInterval < 10*time.Millisecond {
		ackInterval = 10 * time.Millisecond
	}
	ackTicker := time.NewTicker(jitteredFirstTick(ackInterval))
	defer ackTicker.Stop()
	ackSteady := false
	for {
		if len(c.acks.expired(time.Now())) > 0 {
			c.closeForRecovery()
			return
		}
		select {
		case <-c.ctx.Done():
			return
		case next := <-c.out:
			c.mu.Lock()
			if !c.closed {
				c.queuedBytes -= len(next.payload)
				c.server.metrics.QueuedBytes.Sub(float64(len(next.payload)))
			}
			c.mu.Unlock()
			if err := c.acks.markSent(next.event, time.Now()); err != nil {
				c.closeForRecovery()
				return
			}
			if err := c.socket.SetWriteDeadline(time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
			if err := c.socket.WriteMessage(websocket.TextMessage, next.payload); err != nil {
				return
			}
		case <-ackTicker.C:
			if !ackSteady {
				ackTicker.Reset(ackInterval)
				ackSteady = true
			}
			if len(c.acks.expired(time.Now())) > 0 {
				c.closeForRecovery()
				return
			}
		case <-pingTicker.C:
			if !pingSteady {
				pingTicker.Reset(c.server.config.PingInterval)
				pingSteady = true
			}
			if err := c.socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
		}
	}
}

func (c *Connection) closeForRecovery() {
	c.server.metrics.RecoveryCloses.Inc()
	deadline := time.Now().Add(c.server.config.WriteTimeout)
	_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "recovery_required"), deadline)
}

func (c *Connection) readLoop() {
	defer c.Close()
	c.socket.SetReadLimit(c.server.config.MaxFrameBytes)
	_ = c.socket.SetReadDeadline(time.Now().Add(c.server.config.PongTimeout))
	c.socket.SetPongHandler(func(string) error { return c.socket.SetReadDeadline(time.Now().Add(c.server.config.PongTimeout)) })
	for {
		kind, data, err := c.socket.ReadMessage()
		if err != nil {
			return
		}
		if kind != websocket.TextMessage {
			c.error("invalid_frame", "")
			continue
		}
		frame, err := protocol.DecodeFrame(data)
		if err != nil {
			c.error("invalid_frame", frame.RequestID)
			continue
		}
		if err := c.handle(frame); err != nil {
			code := "dependency_unavailable"
			if errors.Is(err, grpcauth.ErrUnauthorized) {
				code = "unauthorized"
			}
			if errors.Is(err, errRateLimited) {
				code = "rate_limited"
			}
			if errors.Is(err, errRoomLimit) {
				code = "room_limit"
			}
			if errors.Is(err, errInvalidACK) {
				code = "invalid_frame"
			}
			c.error(code, frame.RequestID)
		}
	}
}

func (c *Connection) error(code, requestID string) {
	c.server.metrics.FrameErrors.WithLabelValues(code).Inc()
	c.Enqueue(protocol.Event{Type: "error", Version: 1, Code: code, RequestID: requestID})
}

func (c *Connection) setRoom(chatID, room string) {
	c.mu.Lock()
	c.rooms[chatID] = room
	c.mu.Unlock()
}
func (c *Connection) room(chatID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rooms[chatID]
}
func (c *Connection) removeRoom(chatID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	room := c.rooms[chatID]
	delete(c.rooms, chatID)
	if lease, ok := c.leases[chatID]; ok {
		lease.timer.Stop()
		delete(c.leases, chatID)
	}
	return room
}
func (c *Connection) roomCount() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.rooms) }

func (c *Connection) renewGroup(chatID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.renewGroupLocked(chatID)
}

func (c *Connection) renewGroupLocked(chatID string) {
	if prior, ok := c.leases[chatID]; ok {
		prior.timer.Stop()
	}
	c.leaseSerial++
	serial := c.leaseSerial
	c.leases[chatID] = groupLease{serial: serial, timer: time.AfterFunc(c.server.config.GroupLease, func() { c.expireGroup(chatID, serial) })}
}

func (c *Connection) expireGroup(chatID string, serial uint64) {
	c.mu.Lock()
	lease, ok := c.leases[chatID]
	if !ok || lease.serial != serial || c.closed {
		c.mu.Unlock()
		return
	}
	room := c.rooms[chatID]
	delete(c.leases, chatID)
	delete(c.rooms, chatID)
	c.mu.Unlock()
	if room != "" {
		c.server.rooms.LeaveChat(c, room, chatID)
	}
	c.server.metrics.GroupLeaseExpired.Inc()
	c.Enqueue(protocol.Event{Type: "subscription_expired", Version: 1, ChatID: chatID})
}
