package socket

import (
	"context"
	"errors"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
)

func (subscriptions *chatSubscriptions) joinSubscriptionBatch(base context.Context, items []protocol.Subscription, grants map[string]*groupGrant, authorization subscriptionAuthorization) error {
	attached := make(map[string]*groupGrant, len(grants))
	attachedDirect := make([]string, 0)
	committed := false
	defer func() {
		if !committed {
			for _, chatID := range attachedDirect {
				subscriptions.leave(chatID)
			}
			for chatID, grant := range attached {
				subscriptions.roomCoordinator.LeaveChat(grant, roomname.Group(chatID), chatID)
			}
		}
	}()
	groupIDs := make([]string, 0, len(grants))
	for _, item := range items {
		if item.Kind != protocol.ChatGroup {
			newRoom, err := subscriptions.joinDirect(base, item)
			if newRoom {
				attachedDirect = append(attachedDirect, item.ChatID)
			}
			if err != nil {
				return err
			}
			continue
		}
		groupIDs = append(groupIDs, item.ChatID)
		if err := subscriptions.joinGroup(base, item, grants[item.ChatID], authorization.rooms[item.ChatID], attached); err != nil {
			return err
		}
	}
	if len(attached) > 0 {
		final, err := subscriptions.authorizeSubscriptionBatch(base, groupIDs)
		defer final.release()
		for _, chatID := range final.denied {
			subscriptions.leave(chatID)
		}
		if err != nil {
			return err
		}
		if len(final.denied) > 0 {
			return grpcauth.ErrUnauthorized
		}
	}
	if err := base.Err(); err != nil {
		return err
	}
	if err := subscriptions.commitGroupBatch(base, grants); err != nil {
		return err
	}
	committed = true
	subscriptions.announceJoined(items, attached, authorization)
	return nil
}

func (subscriptions *chatSubscriptions) joinDirect(base context.Context, item protocol.Subscription) (bool, error) {
	newRoom := subscriptions.room(item.ChatID) == ""
	ctx, cancel := context.WithTimeout(base, subscriptions.config.APITimeout)
	err := subscriptions.joinAuthorized(ctx, item.ChatID, item.Kind, item.Epoch, item.StreamID, roomname.User(subscriptions.connection.session.UserID), nil)
	cancel()
	if err != nil && subscriptions.room(item.ChatID) == "" {
		subscriptions.roomCoordinator.LeaveChat(subscriptions.connection, roomname.User(subscriptions.connection.session.UserID), item.ChatID)
	}
	return newRoom, err
}

func (subscriptions *chatSubscriptions) joinGroup(base context.Context, item protocol.Subscription, grant *groupGrant, room string, attached map[string]*groupGrant) error {
	if !subscriptions.allowGroupJoin(item.ChatID, grant) {
		return grpcauth.ErrUnauthorized
	}
	if current := subscriptions.room(item.ChatID); current != "" {
		if current != room {
			return errors.New("subscription kind changed")
		}
		return nil
	}
	ctx, cancel, err := subscriptions.groupAuthorizationContext(base)
	if err != nil {
		return err
	}
	attached[item.ChatID] = grant
	err = subscriptions.roomCoordinator.Join(ctx, grant, room, item.ChatID, item.Epoch, item.StreamID)
	if err == nil {
		err = subscriptions.groupAuthorizationError(ctx)
	}
	cancel()
	if err != nil {
		return err
	}
	if !subscriptions.allowGroupJoin(item.ChatID, grant) {
		return grpcauth.ErrUnauthorized
	}
	return nil
}

func (subscriptions *chatSubscriptions) announceJoined(items []protocol.Subscription, attached map[string]*groupGrant, authorization subscriptionAuthorization) {
	for _, item := range items {
		grant := attached[item.ChatID]
		if grant == nil {
			continue
		}
		room := authorization.rooms[item.ChatID]
		if subscriptions.groupJoinMissed(item.ChatID, grant) {
			grant.Enqueue(protocol.Event{Type: protocol.EventRecoveryFailed, Version: 1, Room: room, ChatID: item.ChatID})
		}
		grant.Enqueue(protocol.Event{Type: protocol.EventSubscribed, Version: 1, Room: room, ChatID: item.ChatID})
	}
}

func (subscriptions *chatSubscriptions) commitGroupBatch(base context.Context, grants map[string]*groupGrant) error {
	connection := subscriptions.connection
	connection.mu.Lock()
	defer connection.mu.Unlock()
	if err := base.Err(); err != nil {
		return err
	}
	if err := connection.admissionError(); err != nil {
		return err
	}
	if connection.state == lifecycleClosed {
		return context.Canceled
	}
	for chatID, grant := range grants {
		if grant == nil || subscriptions.groups[chatID] != grant {
			return grpcauth.ErrUnauthorized
		}
	}
	for chatID, grant := range grants {
		grant.authorize()
		subscriptions.rooms[chatID] = roomname.Group(chatID)
		subscriptions.renewGroupLocked(chatID)
	}
	return nil
}
