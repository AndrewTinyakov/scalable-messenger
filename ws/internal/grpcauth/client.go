package grpcauth

import (
	"context"
	"errors"
	"fmt"

	"google.golang.org/grpc"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials/insecure"
	"google.golang.org/grpc/status"
	authorization "messenger/ws/internal/generated/grpc"
)

var ErrUnauthorized = errors.New("authorization denied")

type Client struct {
	connection *grpc.ClientConn
	service    authorization.ChatAuthorizationClient
}

type Session struct {
	UserID    string
	DeviceID  string
	SessionID string
}

func New(address string) (*Client, error) {
	connection, err := grpc.NewClient(address, grpc.WithTransportCredentials(insecure.NewCredentials()))
	if err != nil {
		return nil, fmt.Errorf("gRPC connection: %w", err)
	}
	return &Client{connection: connection, service: authorization.NewChatAuthorizationClient(connection)}, nil
}

func (c *Client) AuthorizeGroup(ctx context.Context, ticket, chatID string) (string, error) {
	response, err := c.service.AuthorizeGroup(ctx, &authorization.AuthorizeGroupRequest{ChatId: chatID, WsTicket: ticket})
	if err != nil {
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unauthenticated || code == codes.NotFound || code == codes.InvalidArgument {
			return "", ErrUnauthorized
		}
		return "", fmt.Errorf("authorize group: %w", err)
	}
	if response.GetRoom() != "group:"+chatID {
		return "", errors.New("invalid group authorization response")
	}
	return response.GetRoom(), nil
}

func (c *Client) AuthorizeGroups(ctx context.Context, ticket string, chatIDs []string) (map[string]bool, error) {
	response, err := c.service.AuthorizeGroups(ctx, &authorization.AuthorizeGroupsRequest{ChatIds: chatIDs, WsTicket: ticket})
	if err != nil {
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unauthenticated || code == codes.NotFound || code == codes.InvalidArgument {
			return nil, ErrUnauthorized
		}
		return nil, fmt.Errorf("authorize groups: %w", err)
	}
	requested := make(map[string]bool, len(chatIDs))
	for _, id := range chatIDs {
		requested[id] = true
	}
	allowed := make(map[string]bool, len(response.GetAuthorizedChatIds()))
	for _, id := range response.GetAuthorizedChatIds() {
		if !requested[id] || allowed[id] {
			return nil, errors.New("invalid group authorization response")
		}
		allowed[id] = true
	}
	return allowed, nil
}

func (c *Client) ValidateSession(ctx context.Context, ticket string) (Session, error) {
	response, err := c.service.ValidateSession(ctx, &authorization.ValidateSessionRequest{WsTicket: ticket})
	if err != nil {
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unauthenticated || code == codes.NotFound || code == codes.InvalidArgument {
			return Session{}, ErrUnauthorized
		}
		return Session{}, fmt.Errorf("validate session: %w", err)
	}
	if response.GetUserId() == "" || response.GetDeviceId() == "" || response.GetSessionId() == "" {
		return Session{}, errors.New("invalid session validation response")
	}
	return Session{UserID: response.GetUserId(), DeviceID: response.GetDeviceId(), SessionID: response.GetSessionId()}, nil
}

func (c *Client) Close() error { return c.connection.Close() }
