package socket

import (
	"context"
	"errors"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"messenger/ws/internal/monitoring"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/rabbitmq"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/roomname"
	"messenger/ws/internal/ticket"
)

type Connection struct {
	opened            time.Time
	lastPing          atomic.Int64
	closeCode         int
	closeReason       string
	server            *Server
	socket            *websocket.Conn
	session           ticket.Identity
	connectionLeaseID string
	ctx               context.Context
	cancel            context.CancelFunc
	out               chan outbound
	mu                sync.Mutex
	queuedBytes       int
	queuedItems       int
	state             lifecycleState
	subscriptions     *chatSubscriptions
	acks              *ackTracker
	once              sync.Once
	expiry            *time.Timer
	commands          []queuedCommand
	commandBytes      int
	commandState      commandState
	nextLeaseRenewal  time.Time
	sidebarSerial     atomic.Uint64
	presenceSerial    atomic.Uint64
	presenceChatID    string
}

type frameGrants struct {
	group    *groupGrant
	presence *presenceWatch
	sidebar  *sidebarWatch
}

type outbound struct {
	frame         *protocol.EventFrame
	groupGrant    *groupGrant
	presenceWatch *presenceWatch
	sidebarWatch  *sidebarWatch
}

func newConnection(server *Server, socket *websocket.Conn, session ticket.Identity, leaseID string) *Connection {
	server.startRuntime()
	var ctx context.Context
	var cancel context.CancelFunc
	if session.ExpiresAt.IsZero() {
		ctx, cancel = context.WithCancel(server.ctx)
	} else {
		ctx, cancel = context.WithDeadline(server.ctx, session.ExpiresAt)
	}
	c := &Connection{server: server, socket: socket, session: session, connectionLeaseID: leaseID, ctx: ctx, cancel: cancel, out: make(chan outbound, server.config.QueueItems), acks: newACKTracker(server.config.PendingACKLimit, server.config.ACKTimeout)}
	c.opened = time.Now()
	c.acks.metrics = server.metrics
	c.subscriptions = newChatSubscriptions(c)
	c.nextLeaseRenewal = time.Now().Add(jitteredFirstTick(30 * time.Second))
	if !session.ExpiresAt.IsZero() {
		c.mu.Lock()
		c.expiry = time.AfterFunc(time.Until(session.ExpiresAt), c.Close)
		c.mu.Unlock()
	}
	return c
}

func (c *Connection) admissionError() error {
	if !c.session.ExpiresAt.IsZero() && !time.Now().Before(c.session.ExpiresAt) {
		return grpcauth.ErrUnauthorized
	}
	return c.ctx.Err()
}

func (c *Connection) Enqueue(event protocol.Event) bool {
	frame, err := protocol.NewEventFrame(event)
	if err != nil {
		return false
	}
	return c.EnqueueFrame(frame)
}

func (c *Connection) EnqueueFrame(frame *protocol.EventFrame) bool {
	return c.enqueueFrame(frame, frameGrants{})
}

func (c *Connection) enqueueFrame(frame *protocol.EventFrame, grants frameGrants) bool {
	expected, presenceWatch, sidebarWatch := grants.group, grants.presence, grants.sidebar
	terminalChat := frame.Event().Type == protocol.EventChatDeleted
	event := frame.Event()
	if expected != nil && (event.ChatID != expected.chatID || event.Room != roomname.Group(expected.chatID)) {
		return true
	}
	if event.Type == protocol.EventSessionRevoked {
		if event.Room == roomname.User(c.session.UserID) && event.SessionID == c.session.SessionID {
			c.closeRevoked()
		}
		return true
	}
	if terminalChat || (event.Type == protocol.EventMemberRemoved && event.MemberID == c.session.UserID) {
		c.sidebarSerial.Add(1)
		if c.server.sidebar != nil {
			c.server.sidebar.remove(c)
		}
	}
	if terminalChat {
		if expected != nil {
			c.mu.Lock()
			current := c.subscriptions.groups[event.ChatID] == expected
			c.mu.Unlock()
			if !current {
				return true
			}
		}
		c.clearChatPresence(event.ChatID)
		c.subscriptions.revokeGrant(event.ChatID, expected)
		expected = nil
	}
	if event.Type == protocol.EventMemberRemoved {
		if event.MemberID == c.session.UserID && (event.Room == roomname.User(c.session.UserID) || event.Room == roomname.Group(event.ChatID)) {
			c.clearChatPresence(event.ChatID)
			c.subscriptions.revokeGrant(event.ChatID, expected)
		}
		if roomname.IsGroup(event.Room) && event.MemberID == c.session.UserID {
			return true
		}
	}
	c.mu.Lock()
	if expected != nil && c.subscriptions.groups[event.ChatID] != expected {
		c.mu.Unlock()
		return true
	}
	var grant *groupGrant
	if roomname.IsGroup(event.Room) && !terminalChat {
		grant = c.subscriptions.groupGrantLocked(event.ChatID)
		if grant == nil || event.Room != roomname.Group(event.ChatID) {
			if pending := c.subscriptions.groups[event.ChatID]; pending != nil && !pending.authorized() && event.Type != protocol.EventSubscribed {
				pending.miss()
			}
			c.mu.Unlock()
			return true
		}
	}
	if c.state == lifecycleClosed {
		c.mu.Unlock()
		return false
	}
	if c.queuedItems >= c.server.config.QueueItems || c.queuedBytes+frame.Size() > c.server.config.QueueBytes {
		c.mu.Unlock()
		c.server.metrics.SlowCloses.Inc()
		c.noteClose(1006, "outbound_full")
		c.Close()
		return false
	}
	select {
	case c.out <- outbound{frame: frame, groupGrant: grant, presenceWatch: presenceWatch, sidebarWatch: sidebarWatch}:
		c.queuedBytes += frame.Size()
		c.queuedItems++
		c.server.metrics.QueuedItems.Inc()
		c.server.metrics.QueuedBytes.Add(float64(frame.Size()))
		c.mu.Unlock()
		return true
	default:
		c.mu.Unlock()
		c.server.metrics.SlowCloses.Inc()
		c.noteClose(1006, "outbound_full")
		c.Close()
		return false
	}
}

func (c *Connection) closeRevoked() {
	c.noteClose(4003, "session_revoked")
	if c.socket != nil {
		deadline := time.Now().Add(c.server.config.WriteTimeout)
		_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4003, "session_revoked"), deadline)
	}
	c.Close()
}

func (c *Connection) Close() {
	c.once.Do(func() {
		c.acks.close()
		c.mu.Lock()
		if c.expiry != nil {
			c.expiry.Stop()
		}
		if c.closeReason == "" {
			c.closeCode = 1006
			c.closeReason = "transport_closed"
		}
		c.server.metrics.Closes.WithLabelValues(monitoring.CloseCode(c.closeCode), c.closeReason).Inc()
		if !c.opened.IsZero() {
			c.server.metrics.ConnectionLifetime.Observe(time.Since(c.opened).Seconds())
		}
		c.state = lifecycleClosed
		c.clearCommandsLocked()
		grants := c.subscriptions.closeLocked()
		c.server.metrics.QueuedBytes.Sub(float64(c.queuedBytes))
		c.queuedBytes = 0
		c.server.metrics.QueuedItems.Sub(float64(c.queuedItems))
		c.queuedItems = 0
		c.mu.Unlock()
		c.cancel()
		c.clearPresence()
		c.sidebarSerial.Add(1)
		if c.server.sidebar != nil {
			c.server.sidebar.remove(c)
		}
		if c.socket != nil {
			_ = c.socket.Close()
		}
		c.server.rooms.LeaveAll(c)
		for _, grant := range grants {
			c.server.rooms.LeaveAll(grant)
		}
		c.server.remove(c)
		c.server.releaseConnectionLease(c.session.UserID, c.connectionLeaseID)
	})
}

func (c *Connection) writeLoop() {
	defer c.Close()
	pingTicker := time.NewTicker(jitteredFirstTick(c.server.config.PingInterval))
	defer pingTicker.Stop()
	pingState := pingJittered
	var ackTimer deadlineTimer
	defer ackTimer.stop()
	for {
		deadline := c.acks.nextDeadline()
		if !deadline.IsZero() && !time.Now().Before(deadline) {
			c.server.metrics.ACKTimeouts.Inc()
			c.closeForRecovery()
			return
		}
		ackTick := ackTimer.arm(deadline)
		select {
		case <-c.ctx.Done():
			c.noteClose(1001, "context_done")
			return
		case next := <-c.out:
			c.mu.Lock()
			if c.state == lifecycleActive {
				c.queuedBytes -= next.frame.Size()
				c.queuedItems--
				c.server.metrics.QueuedItems.Dec()
				c.server.metrics.QueuedBytes.Sub(float64(next.frame.Size()))
			}
			allowed := c.state == lifecycleActive && (next.groupGrant == nil || next.groupGrant == c.subscriptions.groupGrantLocked(next.frame.Event().ChatID))
			c.mu.Unlock()
			if next.presenceWatch != nil && (c.server.presence == nil || !c.server.presence.current(c, next.presenceWatch)) {
				allowed = false
			}
			if next.sidebarWatch != nil && (c.server.sidebar == nil || !c.server.sidebar.current(c, next.sidebarWatch)) {
				allowed = false
			}
			if !allowed {
				continue
			}
			if err := c.acks.markSent(next.frame.Event(), time.Now()); err != nil {
				c.closeForRecovery()
				return
			}
			if err := c.socket.SetWriteDeadline(time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
			if err := c.socket.WriteMessage(websocket.TextMessage, next.frame.Payload()); err != nil {
				c.noteClose(1006, "write_error")
				return
			}
			c.server.metrics.ObserveFeatureDelivery(next.frame.Event(), time.Now())
			c.server.metrics.Messages.WithLabelValues("outbound").Inc()
			c.server.metrics.MessageBytes.WithLabelValues("outbound").Add(float64(next.frame.Size()))
		case <-ackTick:
			ackTimer.stop()
		case <-c.acks.changed:
		case <-pingTicker.C:
			if pingState == pingJittered {
				pingTicker.Reset(c.server.config.PingInterval)
				pingState = pingSteady
			}
			ping := time.Now().UnixNano()
			c.lastPing.Store(ping)
			if err := c.socket.WriteControl(websocket.PingMessage, []byte(strconv.FormatInt(ping, 10)), time.Now().Add(c.server.config.WriteTimeout)); err != nil {
				return
			}
		}
	}
}

func (c *Connection) closeForRecovery() {
	c.noteClose(4001, "recovery_required")
	c.server.metrics.RecoveryCloses.Inc()
	deadline := time.Now().Add(c.server.config.WriteTimeout)
	_ = c.socket.WriteControl(websocket.CloseMessage, websocket.FormatCloseMessage(4001, "recovery_required"), deadline)
}

func (c *Connection) readLoop() {
	defer c.Close()
	c.socket.SetReadLimit(c.server.config.MaxFrameBytes)
	_ = c.socket.SetReadDeadline(time.Now().Add(c.server.config.PongTimeout))
	c.socket.SetPongHandler(func(payload string) error {
		if sent, err := strconv.ParseInt(payload, 10, 64); err == nil && sent == c.lastPing.Load() && sent > 0 {
			c.server.metrics.PingRTT.Observe(max(0, time.Since(time.Unix(0, sent)).Seconds()))
		}
		return c.socket.SetReadDeadline(time.Now().Add(c.server.config.PongTimeout))
	})
	for {
		kind, data, err := c.socket.ReadMessage()
		if err != nil {
			var closed *websocket.CloseError
			if errors.As(err, &closed) {
				c.noteClose(closed.Code, "peer_close")
			} else {
				c.noteClose(1006, "read_error")
			}
			return
		}
		c.server.metrics.Messages.WithLabelValues("inbound").Inc()
		c.server.metrics.MessageBytes.WithLabelValues("inbound").Add(float64(len(data)))
		if kind != websocket.TextMessage {
			c.error(protocol.ErrorInvalidFrame, "")
			continue
		}
		frame, err := protocol.DecodeFrame(data)
		if err != nil {
			c.error(protocol.ErrorInvalidFrame, frame.RequestID)
			continue
		}
		switch frame.Type {
		case protocol.FrameApplied, protocol.FrameDismissed, protocol.FrameReceivedMessage:
			err = c.handle(frame)
		default:
			err = c.enqueueCommand(frame, len(data))
		}
		if err != nil {
			c.handleError(err, frame.RequestID)
		}
	}
}

func (c *Connection) handleError(err error, requestID string) {
	code := protocol.ErrorDependencyUnavailable
	if errors.Is(err, errPublishCommand) {
		code = protocol.ErrorPublishFailed
		if errors.Is(err, rabbitmq.ErrUnknownOutcome) {
			code = protocol.ErrorPublishUnknown
		}
	}
	if errors.Is(err, grpcauth.ErrUnauthorized) {
		code = protocol.ErrorUnauthorized
	}
	if errors.Is(err, errRateLimited) || errors.Is(err, errCommandCapacity) {
		code = protocol.ErrorRateLimited
	}
	if errors.Is(err, errRoomLimit) || errors.Is(err, roomregistry.ErrCapacity) {
		code = protocol.ErrorRoomLimit
	}
	if errors.Is(err, errInvalidACK) {
		code = protocol.ErrorInvalidFrame
	}
	c.error(code, requestID)
}

func (c *Connection) error(code protocol.ErrorCode, requestID string) {
	c.server.metrics.RecordFrameError(code)
	c.Enqueue(protocol.Event{Type: protocol.EventError, Version: 1, Code: code, RequestID: requestID})
}

func (c *Connection) noteClose(code int, reason string) {
	c.mu.Lock()
	if c.closeReason == "" {
		c.closeCode, c.closeReason = code, reason
	}
	c.mu.Unlock()
}
