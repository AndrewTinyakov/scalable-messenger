package socket

import (
	"context"
	"errors"
	"fmt"
	"time"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
)

var errRateLimited = errors.New("rate limited")

var errRoomLimit = errors.New("room limit")

var errPublishCommand = errors.New("publish command")

func (c *Connection) handle(f protocol.Frame) error {
	return c.handleContext(c.ctx, f)
}

func (c *Connection) handleContext(base context.Context, f protocol.Frame) error {
	switch f.Type {
	case protocol.FrameWatchSidebar:
		return c.watchSidebar(base, f.ChatIDs)
	case protocol.FrameSubscribe:
		return c.subscriptions.subscribeContext(base, []protocol.Subscription{{ChatID: f.ChatID, Kind: f.Kind, Epoch: f.Epoch, StreamID: f.StreamID}}, singleSubscription)
	case protocol.FrameSubscribeMany:
		return c.subscriptions.subscribeContext(base, f.Subscriptions, batchSubscription)
	case protocol.FrameUnsubscribe:
		c.subscriptions.leave(f.ChatID)
		return nil
	case protocol.FrameWatchPresence:
		return c.watchPresence(base, f)
	case protocol.FrameWatchOnline:
		return c.watchOnlineCount(base, f.ChatID)
	case protocol.FrameActivity:
		c.setActivity(f.Active, f.Visible)
		return nil
	case protocol.FrameSend:
		return c.send(base, f)
	case protocol.FrameApplied:
		return c.acknowledged(c.acks.apply(f.ChatID, f.Sequence), c.server.metrics.RecordApplied)
	case protocol.FrameDismissed:
		return c.acknowledged(c.acks.dismiss(f.ChatID, f.Sequence), c.server.metrics.RecordDismissed)
	case protocol.FrameReceivedMessage:
		return c.acknowledged(c.acks.receivedMessage(f.ChatID, f.Sequence), c.server.metrics.RecordReceivedMessage)
	default:
		return errors.New("unknown frame")
	}
}

func (c *Connection) acknowledged(err error, record func(monitoring.AcknowledgementOutcome)) error {
	if err != nil {
		record(monitoring.AcknowledgementRejected)
		return err
	}
	record(monitoring.AcknowledgementAccepted)
	return nil
}

func (c *Connection) send(base context.Context, f protocol.Frame) error {
	ctx, cancel := context.WithTimeout(base, c.server.config.ConfirmTimeout)
	defer cancel()
	if err := c.admitSend(ctx); err != nil {
		return err
	}
	command := protocol.SendCommand{Version: 1, ChatID: f.ChatID, RecipientID: f.RecipientID, RequestID: f.RequestID, SenderID: c.session.UserID, Body: f.Body, ReplyToMessageID: f.ReplyToMessageID, ForwardChatID: f.ForwardFromChatID, ForwardMessageID: f.ForwardFromMsgID, SentAt: time.Now().UTC().Format(time.RFC3339Nano)}
	started := time.Now()
	if err := c.server.publisher.Publish(ctx, command); err != nil {
		c.server.metrics.ObservePublish(time.Since(started), monitoring.PublishFailed)
		return fmt.Errorf("%w: %w", errPublishCommand, err)
	}
	c.server.metrics.ObservePublish(time.Since(started), monitoring.PublishConfirmed)
	c.Enqueue(protocol.Event{Type: protocol.EventQueued, Version: 1, ChatID: f.ChatID, RecipientID: f.RecipientID, RequestID: f.RequestID})
	return nil
}

func (c *Connection) admitSend(ctx context.Context) error {
	started := time.Now()
	allowed, err := c.server.sendLimiter.AllowSend(ctx, c.session.UserID)
	result := "allowed"
	if err != nil {
		result = "failed"
	} else if !allowed {
		result = "limited"
	}
	c.server.metrics.SendAdmission.WithLabelValues(result).Observe(time.Since(started).Seconds())
	if err != nil {
		return fmt.Errorf("rate limit: %w", err)
	}
	if !allowed {
		return errRateLimited
	}
	return nil
}
