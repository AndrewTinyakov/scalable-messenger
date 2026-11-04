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
	case protocol.FrameUnwatchPresence:
		c.clearPresence()
		return nil
	case protocol.FrameSend:
		ctx, cancel := context.WithTimeout(base, c.server.config.ConfirmTimeout)
		defer cancel()
		admissionStarted := time.Now()
		allowed, err := c.server.sendLimiter.AllowSend(ctx, c.session.UserID)
		result := "allowed"
		if err != nil {
			result = "failed"
		} else if !allowed {
			result = "limited"
		}
		c.server.metrics.SendAdmission.WithLabelValues(result).Observe(time.Since(admissionStarted).Seconds())
		if err != nil {
			return fmt.Errorf("rate limit: %w", err)
		}
		if !allowed {
			return errRateLimited
		}
		command := protocol.SendCommand{Version: 1, ChatID: f.ChatID, RecipientID: f.RecipientID, RequestID: f.RequestID, SenderID: c.session.UserID, Body: f.Body, ReplyToMessageID: f.ReplyToMessageID, SentAt: time.Now().UTC().Format(time.RFC3339Nano)}
		started := time.Now()
		if err := c.server.publisher.Publish(ctx, command); err != nil {
			c.server.metrics.ObservePublish(time.Since(started), monitoring.PublishFailed)
			return fmt.Errorf("%w: %w", errPublishCommand, err)
		}
		c.server.metrics.ObservePublish(time.Since(started), monitoring.PublishConfirmed)
		c.Enqueue(protocol.Event{Type: protocol.EventQueued, Version: 1, ChatID: f.ChatID, RecipientID: f.RecipientID, RequestID: f.RequestID})
		return nil
	case protocol.FrameApplied:
		err := c.acks.apply(f.ChatID, f.Sequence)
		if err != nil {
			c.server.metrics.RecordApplied(monitoring.AcknowledgementRejected)
			return err
		}
		c.server.metrics.RecordApplied(monitoring.AcknowledgementAccepted)
		return nil
	case protocol.FrameDismissed:
		err := c.acks.dismiss(f.ChatID, f.Sequence)
		if err != nil {
			c.server.metrics.RecordDismissed(monitoring.AcknowledgementRejected)
			return err
		}
		c.server.metrics.RecordDismissed(monitoring.AcknowledgementAccepted)
		return nil
	case protocol.FrameReceivedMessage:
		err := c.acks.receivedMessage(f.ChatID, f.Sequence)
		if err != nil {
			c.server.metrics.RecordReceivedMessage(monitoring.AcknowledgementRejected)
			return err
		}
		c.server.metrics.RecordReceivedMessage(monitoring.AcknowledgementAccepted)
		return nil
	default:
		return errors.New("unknown frame")
	}
}
