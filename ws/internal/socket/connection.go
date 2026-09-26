package socket

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"messenger/ws/internal/apiclient"
	"messenger/ws/internal/protocol"
)

type Connection struct {
	server      *Server
	socket      *websocket.Conn
	session     apiclient.Session
	token       string
	ctx         context.Context
	cancel      context.CancelFunc
	out         chan outbound
	mu          sync.Mutex
	queuedBytes int
	closed      bool
	rooms       map[string]string
	acks        *ackTracker
	once        sync.Once
}

type outbound struct {
	payload []byte
	event   protocol.Event
}

func newConnection(server *Server, socket *websocket.Conn, session apiclient.Session, token string) *Connection {
	ctx, cancel := context.WithCancel(server.ctx)
	return &Connection{server: server, socket: socket, session: session, token: token, ctx: ctx, cancel: cancel, out: make(chan outbound, server.config.QueueItems), rooms: make(map[string]string), acks: newACKTracker(server.config.PendingACKLimit, server.config.ACKTimeout)}
}

func (c *Connection) Enqueue(event protocol.Event) bool {
	if event.Version == 0 {
		event.Version = 1
	}
	data, err := json.Marshal(event)
	if err != nil {
		return false
	}
	c.mu.Lock()
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

func (c *Connection) Close() {
	c.once.Do(func() {
		c.mu.Lock()
		c.closed = true
		c.server.metrics.QueuedBytes.Sub(float64(c.queuedBytes))
		c.queuedBytes = 0
		c.mu.Unlock()
		c.cancel()
		_ = c.socket.Close()
		c.server.rooms.LeaveAll(c)
		c.server.remove(c)
	})
}

func (c *Connection) writeLoop() {
	defer c.Close()
	ticker := time.NewTicker(c.server.config.PingInterval)
	defer ticker.Stop()
	ackInterval := c.server.config.ACKTimeout / 4
	if ackInterval > time.Second {
		ackInterval = time.Second
	}
	if ackInterval < 10*time.Millisecond {
		ackInterval = 10 * time.Millisecond
	}
	ackTicker := time.NewTicker(ackInterval)
	defer ackTicker.Stop()
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
			if len(c.acks.expired(time.Now())) > 0 {
				c.closeForRecovery()
				return
			}
		case <-ticker.C:
			if err := c.socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
		}
	}
}

func (c *Connection) closeForRecovery() {
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
			if errors.Is(err, apiclient.ErrUnauthorized) {
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
	c.Enqueue(protocol.Event{Type: "error", Version: 1, Code: code, RequestID: requestID})
}

func (c *Connection) setRoom(conversationID, room string) {
	c.mu.Lock()
	c.rooms[conversationID] = room
	c.mu.Unlock()
}
func (c *Connection) room(conversationID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.rooms[conversationID]
}
func (c *Connection) removeRoom(conversationID string) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	room := c.rooms[conversationID]
	delete(c.rooms, conversationID)
	return room
}
func (c *Connection) roomCount() int { c.mu.Lock(); defer c.mu.Unlock(); return len(c.rooms) }
