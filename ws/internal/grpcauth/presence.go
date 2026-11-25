package grpcauth

import (
	"context"
	"errors"
	"fmt"
	"time"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"

	authorization "messenger/ws/internal/generated/grpc"
)

type PresenceLevel uint8

const (
	PresenceNone PresenceLevel = iota
	PresenceCoarse
	PresenceFull
)

type Visibility struct {
	Level    PresenceLevel
	LastSeen time.Time
}

type LastSeen struct {
	UserID string
	SeenAt time.Time
}

func (c *Client) PresenceVisibility(ctx context.Context, sessionID string, userIDs []string) (map[string]Visibility, error) {
	response, err := c.service.PresenceVisibility(ctx, &authorization.PresenceVisibilityRequest{SessionId: sessionID, UserIds: userIDs})
	if err != nil {
		if code := status.Code(err); code == codes.Unauthenticated || code == codes.InvalidArgument {
			return nil, ErrUnauthorized
		}
		return nil, fmt.Errorf("presence visibility: %w", err)
	}
	requested := make(map[string]bool, len(userIDs))
	for _, id := range userIDs {
		requested[id] = true
	}
	result := make(map[string]Visibility, len(userIDs))
	for _, subject := range response.GetSubjects() {
		if _, seen := result[subject.GetUserId()]; seen || !requested[subject.GetUserId()] {
			return nil, errors.New("invalid presence visibility response")
		}
		visibility := Visibility{}
		switch subject.GetLevel() {
		case authorization.PresenceLevel_PRESENCE_LEVEL_FULL:
			visibility.Level = PresenceFull
		case authorization.PresenceLevel_PRESENCE_LEVEL_COARSE:
			visibility.Level = PresenceCoarse
		}
		if seen := subject.GetLastSeenUnixMs(); seen > 0 {
			visibility.LastSeen = time.UnixMilli(seen)
		}
		result[subject.GetUserId()] = visibility
	}
	return result, nil
}

func (c *Client) OnlineCountMembers(ctx context.Context, sessionID, chatID string, limit int) (int, []string, error) {
	response, err := c.service.OnlineCountMembers(ctx, &authorization.OnlineCountMembersRequest{SessionId: sessionID, ChatId: chatID, Limit: int32(limit)})
	if err != nil {
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unauthenticated || code == codes.NotFound || code == codes.InvalidArgument {
			return 0, nil, ErrUnauthorized
		}
		return 0, nil, fmt.Errorf("online count members: %w", err)
	}
	members := response.GetMemberIds()
	if response.GetMemberCount() < 1 || len(members) > limit || (len(members) > 0 && len(members) != int(response.GetMemberCount())) {
		return 0, nil, errors.New("invalid online count members response")
	}
	return int(response.GetMemberCount()), members, nil
}

func (c *Client) RecordLastSeen(ctx context.Context, entries []LastSeen) error {
	request := &authorization.RecordLastSeenRequest{Entries: make([]*authorization.LastSeen, len(entries))}
	for index, entry := range entries {
		request.Entries[index] = &authorization.LastSeen{UserId: entry.UserID, SeenUnixMs: entry.SeenAt.UnixMilli()}
	}
	if _, err := c.service.RecordLastSeen(ctx, request); err != nil {
		return fmt.Errorf("record last seen: %w", err)
	}
	return nil
}
