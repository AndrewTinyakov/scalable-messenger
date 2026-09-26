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
	out         chan []byte
	mu          sync.Mutex
	queuedBytes int
	closed      bool
	rooms       map[string]string
	applied     map[string]string
	once        sync.Once
}

func newConnection(server *Server, socket *websocket.Conn, session apiclient.Session, token string) *Connection {
	ctx, cancel := context.WithCancel(server.ctx)
	return &Connection{server: server, socket: socket, session: session, token: token, ctx: ctx, cancel: cancel, out: make(chan []byte, server.config.QueueItems), rooms: make(map[string]string), applied: make(map[string]string)}
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
	case c.out <- data:
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
	for {
		select {
		case <-c.ctx.Done():
			return
		case data := <-c.out:
			c.mu.Lock()
			if !c.closed {
				c.queuedBytes -= len(data)
				c.server.metrics.QueuedBytes.Sub(float64(len(data)))
			}
			c.mu.Unlock()
			if err := c.socket.SetWriteDeadline(time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
			if err := c.socket.WriteMessage(websocket.TextMessage, data); err != nil {
				return
			}
		case <-ticker.C:
			if err := c.socket.WriteControl(websocket.PingMessage, nil, time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
		}
	}
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
