package socket

import (
	"context"
	"errors"
	"fmt"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

func (c *Connection) subscribeMany(subscriptions []protocol.Subscription) error {
	newRooms := 0
	groupIDs := make([]string, 0, len(subscriptions))
	revisions := make(map[string]uint64, len(subscriptions))
	for _, subscription := range subscriptions {
		if c.room(subscription.ChatID) == "" {
			newRooms++
		}
		if subscription.Kind == "group" {
			groupIDs = append(groupIDs, subscription.ChatID)
			revisions[subscription.ChatID] = c.revocation(subscription.ChatID)
		}
	}
	if c.roomCount()+newRooms > c.server.config.MaxRoomsPerConnection {
		return errRoomLimit
	}
	if len(subscriptions) > c.server.config.SubscribeRate && c.server.subscribeLimiter != nil {
		return errRateLimited
	}
	if c.server.subscribeLimiter != nil {
		ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
		allowed, err := c.server.subscribeLimiter.AllowSubscribeBatch(ctx, c.session.UserID, len(subscriptions), c.server.config.SubscribeRate, c.server.config.SubscribeWindow)
		cancel()
		if err != nil {
			return fmt.Errorf("limit subscriptions: %w", err)
		}
		if !allowed {
			return errRateLimited
		}
	}
	if len(groupIDs) > 0 {
		if c.server.groupAuthSlots != nil {
			select {
			case c.server.groupAuthSlots <- struct{}{}:
			case <-c.ctx.Done():
				return c.ctx.Err()
			default:
				return errRateLimited
			}
		}
		ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
		started := time.Now()
		allowed, err := c.server.groupAuth.AuthorizeGroups(ctx, c.token, groupIDs)
		cancel()
		if c.server.groupAuthSlots != nil {
			<-c.server.groupAuthSlots
		}
		result := "authorized"
		if errors.Is(err, grpcauth.ErrUnauthorized) {
			result = "denied"
		} else if err != nil {
			result = "error"
		}
		c.server.metrics.GroupAuthSeconds.WithLabelValues(result).Observe(time.Since(started).Seconds())
		if err != nil {
			return err
		}
		denied := false
		for _, id := range groupIDs {
			if !allowed[id] {
				if old := c.removeRoom(id); old != "" {
					c.server.rooms.LeaveChat(c, old, id)
				}
				denied = true
			}
		}
		if denied {
			return grpcauth.ErrUnauthorized
		}
	}
	for _, subscription := range subscriptions {
		room := "user:" + c.session.UserID
		if subscription.Kind == "group" {
			room = "group:" + subscription.ChatID
		}
		ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
		err := c.joinAuthorized(ctx, subscription.ChatID, subscription.Kind, subscription.Epoch, subscription.StreamID, room, revisions[subscription.ChatID])
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *Connection) joinAuthorized(ctx context.Context, chatID, kind, epoch, streamID, room string, revision uint64) error {
	if kind == "group" && !c.allowGroupJoin(chatID, revision) {
		return grpcauth.ErrUnauthorized
	}
	if current := c.room(chatID); current != "" {
		if current != room {
			return errors.New("subscription kind changed")
		}
		if kind == "group" && !c.commitGroupJoin(chatID, room, revision) {
			return grpcauth.ErrUnauthorized
		}
		return nil
	}
	if err := c.server.rooms.Join(ctx, c, room, chatID, epoch, streamID); err != nil {
		return err
	}
	if kind == "group" {
		if !c.commitGroupJoin(chatID, room, revision) {
			c.server.rooms.LeaveChat(c, room, chatID)
			return grpcauth.ErrUnauthorized
		}
	} else {
		c.setRoom(chatID, room)
	}
	return nil
}
