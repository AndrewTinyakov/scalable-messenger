package socket

import (
	"strconv"
	"time"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
)

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
	expected, handled := c.applyControlEvent(frame.Event(), grants.group)
	if handled {
		return true
	}
	return c.admitFrame(frame, expected, grants)
}

func (c *Connection) applyControlEvent(event protocol.Event, expected *groupGrant) (*groupGrant, bool) {
	terminalChat := event.Type == protocol.EventChatDeleted
	if expected != nil && (event.ChatID != expected.chatID || event.Room != roomname.Group(expected.chatID)) {
		return nil, true
	}
	if event.Type == protocol.EventSessionRevoked {
		if event.Room == roomname.User(c.session.UserID) && event.SessionID == c.session.SessionID {
			c.closeRevoked()
		}
		return nil, true
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
				return nil, true
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
			return nil, true
		}
	}
	return expected, false
}

func (c *Connection) admitFrame(frame *protocol.EventFrame, expected *groupGrant, grants frameGrants) bool {
	event := frame.Event()
	c.mu.Lock()
	if expected != nil && c.subscriptions.groups[event.ChatID] != expected {
		c.mu.Unlock()
		return true
	}
	var grant *groupGrant
	if roomname.IsGroup(event.Room) && event.Type != protocol.EventChatDeleted {
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
		return c.closeSlow()
	}
	select {
	case c.out <- outbound{frame: frame, groupGrant: grant, presenceWatch: grants.presence, sidebarWatch: grants.sidebar}:
		c.queuedBytes += frame.Size()
		c.queuedItems++
		c.server.metrics.QueuedItems.Inc()
		c.server.metrics.QueuedBytes.Add(float64(frame.Size()))
		c.mu.Unlock()
		return true
	default:
		c.mu.Unlock()
		return c.closeSlow()
	}
}

func (c *Connection) closeSlow() bool {
	c.server.metrics.SlowCloses.Inc()
	c.noteClose(1006, "outbound_full")
	c.Close()
	return false
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
