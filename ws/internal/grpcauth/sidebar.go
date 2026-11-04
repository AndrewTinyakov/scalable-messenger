package grpcauth

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/status"
	authorization "messenger/ws/internal/generated/grpc"
)

type SidebarChat struct {
	ChatID string
	PeerID string
	Group  bool
}

func (c *Client) AuthorizeSidebar(ctx context.Context, sessionID string, chatIDs []string) ([]SidebarChat, error) {
	response, err := c.service.AuthorizeSidebar(ctx, &authorization.AuthorizeSidebarRequest{SessionId: sessionID, ChatIds: chatIDs})
	if err != nil {
		switch status.Code(err) {
		case codes.PermissionDenied, codes.Unauthenticated, codes.NotFound, codes.InvalidArgument:
			return nil, ErrUnauthorized
		}
		return nil, fmt.Errorf("authorize sidebar: %w", err)
	}
	requested := make(map[string]bool, len(chatIDs))
	for _, id := range chatIDs {
		requested[id] = true
	}
	result := make([]SidebarChat, 0, len(response.Chats))
	for _, chat := range response.Chats {
		if !requested[chat.ChatId] || (chat.Group && chat.PeerId != "") {
			return nil, errors.New("invalid sidebar authorization response")
		}
		delete(requested, chat.ChatId)
		result = append(result, SidebarChat{ChatID: chat.ChatId, PeerID: chat.PeerId, Group: chat.Group})
	}
	return result, nil
}
