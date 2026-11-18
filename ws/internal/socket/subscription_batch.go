package socket

import (
	"context"
	"errors"
	"fmt"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
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

func (subscriptions *chatSubscriptions) subscribeOne(subscription protocol.Subscription) error {
	return subscriptions.subscribe([]protocol.Subscription{subscription}, singleSubscription)
}

func (subscriptions *chatSubscriptions) subscribeMany(items []protocol.Subscription) error {
	return subscriptions.subscribe(items, batchSubscription)
}

func (subscriptions *chatSubscriptions) subscribe(items []protocol.Subscription, mode subscriptionMode) error {
	return subscriptions.subscribeContext(subscriptions.connection.ctx, items, mode)
}

func (subscriptions *chatSubscriptions) subscribeContext(base context.Context, items []protocol.Subscription, mode subscriptionMode) error {
	if err := base.Err(); err != nil {
		return err
	}
	newRooms := 0
	groupIDs := make([]string, 0, len(items))
	grants := make(map[string]*groupGrant, len(items))
	defer subscriptions.finishGroupAuthorizations(grants)
	for _, subscription := range items {
		if subscriptions.room(subscription.ChatID) == "" {
			newRooms++
		}
		if subscription.Kind == protocol.ChatGroup {
			groupIDs = append(groupIDs, subscription.ChatID)
			grants[subscription.ChatID] = subscriptions.beginGroupAuthorization(subscription.ChatID)
		}
	}
	if subscriptions.count()+newRooms > subscriptions.config.MaxRoomsPerConnection {
		return errRoomLimit
	}
	if err := subscriptions.chargeSubscriptionAttempts(base, len(items), mode); err != nil {
		return err
	}

	authorization, err := subscriptions.authorizeSubscriptions(base, groupIDs, mode)
	defer authorization.release()
	for _, chatID := range authorization.denied {
		subscriptions.leave(chatID)
	}
	if err != nil {
		return err
	}
	if len(authorization.denied) > 0 {
		return grpcauth.ErrUnauthorized
	}
	if mode == batchSubscription {
		return subscriptions.joinSubscriptionBatch(base, items, grants, authorization)
	}
	return subscriptions.joinSubscriptions(base, items, grants, authorization)
}

func (subscriptions *chatSubscriptions) chargeSubscriptionAttempts(base context.Context, count int, mode subscriptionMode) error {
	if subscriptions.subscribeLimiter == nil {
		return nil
	}
	if mode == batchSubscription && count > subscriptions.config.SubscribeRate {
		return errRateLimited
	}
	ctx, cancel := context.WithTimeout(base, subscriptions.config.APITimeout)
	defer cancel()
	var allowed bool
	var err error
	if mode == batchSubscription {
		allowed, err = subscriptions.subscribeLimiter.AllowSubscribeBatch(ctx, subscriptions.connection.session.UserID, count, subscriptions.config.SubscribeRate, subscriptions.config.SubscribeWindow)
	} else {
		allowed, err = subscriptions.subscribeLimiter.AllowSubscribe(ctx, subscriptions.connection.session.UserID, subscriptions.config.SubscribeRate, subscriptions.config.SubscribeWindow)
	}
	if err != nil {
		return fmt.Errorf("limit subscriptions: %w", err)
	}
	if !allowed {
		return errRateLimited
	}
	return nil
}

func (subscriptions *chatSubscriptions) authorizeSubscriptions(base context.Context, groupIDs []string, mode subscriptionMode) (subscriptionAuthorization, error) {
	if mode == batchSubscription {
		return subscriptions.authorizeSubscriptionBatch(base, groupIDs)
	}
	return subscriptions.authorizeSingleSubscription(base, groupIDs)
}

func (subscriptions *chatSubscriptions) authorizeSingleSubscription(base context.Context, groupIDs []string) (subscriptionAuthorization, error) {
	ctx, cancel := context.WithTimeout(base, subscriptions.config.APITimeout)
	authorization := subscriptionAuthorization{
		rooms:   make(map[string]string, len(groupIDs)),
		joinCtx: ctx,
		release: cancel,
	}
	if len(groupIDs) == 0 {
		return authorization, nil
	}
	cancel()
	ctx, cancel, err := subscriptions.groupAuthorizationContext(base)
	if err != nil {
		authorization.denied = append(authorization.denied, groupIDs...)
		return authorization, err
	}
	authorization.release = cancel
	authorization.joinCtx = ctx
	if subscriptions.groupAuthSlots != nil {
		select {
		case subscriptions.groupAuthSlots <- struct{}{}:
			authorization.release = func() {
				<-subscriptions.groupAuthSlots
				cancel()
			}
		default:
			return authorization, errRateLimited
		}
	}
	started := time.Now()
	room, err := subscriptions.groupAuth.AuthorizeGroup(ctx, subscriptions.connection.session.SessionID, groupIDs[0])
	if err == nil {
		err = subscriptions.groupAuthorizationError(ctx)
	}
	subscriptions.observeGroupAuthorization(started, err)
	if errors.Is(err, grpcauth.ErrUnauthorized) {
		authorization.denied = append(authorization.denied, groupIDs[0])
	}
	if err == nil {
		authorization.rooms[groupIDs[0]] = room
	}
	return authorization, err
}

func (subscriptions *chatSubscriptions) authorizeSubscriptionBatch(base context.Context, groupIDs []string) (subscriptionAuthorization, error) {
	authorization := subscriptionAuthorization{
		rooms:   make(map[string]string, len(groupIDs)),
		release: func() {},
	}
	if len(groupIDs) == 0 {
		return authorization, nil
	}
	if subscriptions.groupAuthSlots != nil {
		select {
		case subscriptions.groupAuthSlots <- struct{}{}:
			defer func() { <-subscriptions.groupAuthSlots }()
		case <-subscriptions.connection.ctx.Done():
			return authorization, subscriptions.connection.ctx.Err()
		default:
			return authorization, errRateLimited
		}
	}
	ctx, cancel, err := subscriptions.groupAuthorizationContext(base)
	if err != nil {
		authorization.denied = append(authorization.denied, groupIDs...)
		return authorization, err
	}
	started := time.Now()
	allowed, err := subscriptions.groupAuth.AuthorizeGroups(ctx, subscriptions.connection.session.SessionID, groupIDs)
	if err == nil {
		err = subscriptions.groupAuthorizationError(ctx)
	}
	cancel()
	subscriptions.observeGroupAuthorization(started, err)
	if err != nil {
		if errors.Is(err, grpcauth.ErrUnauthorized) {
			authorization.denied = append(authorization.denied, groupIDs...)
		}
		return authorization, err
	}
	for _, chatID := range groupIDs {
		if allowed[chatID] {
			authorization.rooms[chatID] = roomname.Group(chatID)
		} else {
			authorization.denied = append(authorization.denied, chatID)
		}
	}
	return authorization, nil
}

func (subscriptions *chatSubscriptions) observeGroupAuthorization(started time.Time, err error) {
	result := monitoring.AuthorizationAuthorized
	if errors.Is(err, grpcauth.ErrUnauthorized) {
		result = monitoring.AuthorizationDenied
	} else if err != nil {
		result = monitoring.AuthorizationError
	}
	subscriptions.metrics.ObserveGroupAuthorization(time.Since(started), result)
}

func (subscriptions *chatSubscriptions) joinSubscriptions(base context.Context, items []protocol.Subscription, grants map[string]*groupGrant, authorization subscriptionAuthorization) error {
	for _, subscription := range items {
		room := roomname.User(subscriptions.connection.session.UserID)
		if subscription.Kind == protocol.ChatGroup {
			room = authorization.rooms[subscription.ChatID]
		}
		ctx := authorization.joinCtx
		cancel := func() {}
		if ctx == nil {
			ctx, cancel = context.WithTimeout(base, subscriptions.config.APITimeout)
		}
		err := subscriptions.joinAuthorized(ctx, subscription.ChatID, subscription.Kind, subscription.Epoch, subscription.StreamID, room, grants[subscription.ChatID])
		cancel()
		if err != nil {
			return err
		}
	}
	return nil
}

func (subscriptions *chatSubscriptions) joinAuthorized(ctx context.Context, chatID string, kind protocol.ChatKind, epoch, streamID, room string, grant *groupGrant) error {
	if err := subscriptions.connection.ctx.Err(); err != nil {
		return err
	}
	if kind == protocol.ChatGroup && !subscriptions.allowGroupJoin(chatID, grant) {
		return grpcauth.ErrUnauthorized
	}
	if current := subscriptions.room(chatID); current != "" {
		if current != room {
			return errors.New("subscription kind changed")
		}
		if kind == protocol.ChatGroup && !subscriptions.commitGroupJoin(chatID, room, grant) {
			return grpcauth.ErrUnauthorized
		}
		return nil
	}
	recipient := subscriptions.recipient(grant)
	if err := subscriptions.roomCoordinator.Join(ctx, recipient, room, chatID, epoch, streamID); err != nil {
		return err
	}
	if kind == protocol.ChatGroup {
		if !subscriptions.allowGroupJoin(chatID, grant) {
			subscriptions.roomCoordinator.LeaveChat(recipient, room, chatID)
			return grpcauth.ErrUnauthorized
		}
		validateCtx, cancel, err := subscriptions.groupAuthorizationContext(ctx)
		if err != nil {
			subscriptions.roomCoordinator.LeaveChat(recipient, room, chatID)
			return err
		}
		validatedRoom, err := subscriptions.groupAuth.AuthorizeGroup(validateCtx, subscriptions.connection.session.SessionID, chatID)
		if err == nil {
			err = subscriptions.groupAuthorizationError(validateCtx)
		}
		cancel()
		if err != nil || validatedRoom != room {
			subscriptions.roomCoordinator.LeaveChat(recipient, room, chatID)
			if err == nil {
				return grpcauth.ErrUnauthorized
			}
			return err
		}
		if !subscriptions.commitGroupJoin(chatID, room, grant) {
			subscriptions.roomCoordinator.LeaveChat(recipient, room, chatID)
			return grpcauth.ErrUnauthorized
		}
		if subscriptions.groupJoinMissed(chatID, grant) {
			grant.Enqueue(protocol.Event{Type: protocol.EventRecoveryFailed, Version: 1, Room: room, ChatID: chatID})
		}
		grant.Enqueue(protocol.Event{Type: protocol.EventSubscribed, Version: 1, Room: room, ChatID: chatID})
	} else {
		if !subscriptions.setDirectRoom(chatID, room) {
			subscriptions.roomCoordinator.LeaveChat(subscriptions.connection, room, chatID)
			return context.Canceled
		}
	}
	return nil
}

func (subscriptions *chatSubscriptions) groupAuthorizationContext(base context.Context) (context.Context, context.CancelFunc, error) {
	if err := subscriptions.connection.admissionError(); err != nil {
		return nil, func() {}, err
	}
	deadline := time.Now().Add(subscriptions.config.APITimeout)
	if admission := subscriptions.connection.authorizationDeadline(); !admission.IsZero() && admission.Before(deadline) {
		deadline = admission
	}
	ctx, cancel := context.WithDeadline(base, deadline)
	if err := subscriptions.groupAuthorizationError(ctx); err != nil {
		cancel()
		return nil, func() {}, err
	}
	return ctx, cancel, nil
}

func (subscriptions *chatSubscriptions) groupAuthorizationError(ctx context.Context) error {
	if err := subscriptions.connection.admissionError(); err != nil {
		return err
	}
	return ctx.Err()
}
