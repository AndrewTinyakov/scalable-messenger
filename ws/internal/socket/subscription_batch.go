package socket

import (
	"context"
	"errors"
	"fmt"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

type subscriptionMode uint8

const (
	singleSubscription subscriptionMode = iota
	batchSubscription
)

type subscriptionAuthorization struct {
	rooms   map[string]string
	denied  []string
	joinCtx context.Context
	release func()
}

func (c *Connection) subscribeOne(subscription protocol.Subscription) error {
	return c.subscribe([]protocol.Subscription{subscription}, singleSubscription)
}

func (c *Connection) subscribeMany(subscriptions []protocol.Subscription) error {
	return c.subscribe(subscriptions, batchSubscription)
}

func (c *Connection) subscribe(subscriptions []protocol.Subscription, mode subscriptionMode) error {
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
	if err := c.chargeSubscriptionAttempts(len(subscriptions), mode); err != nil {
		return err
	}

	authorization, err := c.authorizeSubscriptions(groupIDs, mode)
	defer authorization.release()
	for _, chatID := range authorization.denied {
		c.leaveChat(chatID)
	}
	if err != nil {
		return err
	}
	if len(authorization.denied) > 0 {
		return grpcauth.ErrUnauthorized
	}
	return c.joinSubscriptions(subscriptions, revisions, authorization)
}

func (c *Connection) chargeSubscriptionAttempts(count int, mode subscriptionMode) error {
	if c.server.subscribeLimiter == nil {
		return nil
	}
	if mode == batchSubscription && count > c.server.config.SubscribeRate {
		return errRateLimited
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
	defer cancel()
	var allowed bool
	var err error
	if mode == batchSubscription {
		allowed, err = c.server.subscribeLimiter.AllowSubscribeBatch(ctx, c.session.UserID, count, c.server.config.SubscribeRate, c.server.config.SubscribeWindow)
	} else {
		allowed, err = c.server.subscribeLimiter.AllowSubscribe(ctx, c.session.UserID, c.server.config.SubscribeRate, c.server.config.SubscribeWindow)
	}
	if err != nil {
		return fmt.Errorf("limit subscriptions: %w", err)
	}
	if !allowed {
		return errRateLimited
	}
	return nil
}

func (c *Connection) authorizeSubscriptions(groupIDs []string, mode subscriptionMode) (subscriptionAuthorization, error) {
	if mode == batchSubscription {
		return c.authorizeSubscriptionBatch(groupIDs)
	}
	return c.authorizeSingleSubscription(groupIDs)
}

func (c *Connection) authorizeSingleSubscription(groupIDs []string) (subscriptionAuthorization, error) {
	ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
	authorization := subscriptionAuthorization{
		rooms:   make(map[string]string, len(groupIDs)),
		joinCtx: ctx,
		release: cancel,
	}
	if len(groupIDs) == 0 {
		return authorization, nil
	}
	if c.server.groupAuthSlots != nil {
		select {
		case c.server.groupAuthSlots <- struct{}{}:
			authorization.release = func() {
				<-c.server.groupAuthSlots
				cancel()
			}
		default:
			return authorization, errRateLimited
		}
	}
	started := time.Now()
	room, err := c.server.groupAuth.AuthorizeGroup(ctx, c.token, groupIDs[0])
	c.observeGroupAuthorization(started, err)
	if errors.Is(err, grpcauth.ErrUnauthorized) {
		authorization.denied = append(authorization.denied, groupIDs[0])
	}
	if err == nil {
		authorization.rooms[groupIDs[0]] = room
	}
	return authorization, err
}

func (c *Connection) authorizeSubscriptionBatch(groupIDs []string) (subscriptionAuthorization, error) {
	authorization := subscriptionAuthorization{
		rooms:   make(map[string]string, len(groupIDs)),
		release: func() {},
	}
	if len(groupIDs) == 0 {
		return authorization, nil
	}
	if c.server.groupAuthSlots != nil {
		select {
		case c.server.groupAuthSlots <- struct{}{}:
			defer func() { <-c.server.groupAuthSlots }()
		case <-c.ctx.Done():
			return authorization, c.ctx.Err()
		default:
			return authorization, errRateLimited
		}
	}
	ctx, cancel := context.WithTimeout(c.ctx, c.server.config.APITimeout)
	started := time.Now()
	allowed, err := c.server.groupAuth.AuthorizeGroups(ctx, c.token, groupIDs)
	cancel()
	c.observeGroupAuthorization(started, err)
	if err != nil {
		return authorization, err
	}
	for _, chatID := range groupIDs {
		if allowed[chatID] {
			authorization.rooms[chatID] = "group:" + chatID
		} else {
			authorization.denied = append(authorization.denied, chatID)
		}
	}
	return authorization, nil
}

func (c *Connection) observeGroupAuthorization(started time.Time, err error) {
	result := "authorized"
	if errors.Is(err, grpcauth.ErrUnauthorized) {
		result = "denied"
	} else if err != nil {
		result = "error"
	}
	c.server.metrics.GroupAuthSeconds.WithLabelValues(result).Observe(time.Since(started).Seconds())
}

func (c *Connection) joinSubscriptions(subscriptions []protocol.Subscription, revisions map[string]uint64, authorization subscriptionAuthorization) error {
	for _, subscription := range subscriptions {
		room := "user:" + c.session.UserID
		if subscription.Kind == "group" {
			room = authorization.rooms[subscription.ChatID]
		}
		ctx := authorization.joinCtx
		cancel := func() {}
		if ctx == nil {
			ctx, cancel = context.WithTimeout(c.ctx, c.server.config.APITimeout)
		}
		err := c.joinAuthorized(ctx, subscription.ChatID, subscription.Kind, subscription.Epoch, subscription.StreamID, room, revisions[subscription.ChatID])
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

func (c *Connection) leaveChat(chatID string) {
	if old := c.removeRoom(chatID); old != "" {
		c.server.rooms.LeaveChat(c, old, chatID)
	}
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
