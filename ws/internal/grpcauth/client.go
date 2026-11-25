package grpcauth

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	"google.golang.org/grpc"
	_ "google.golang.org/grpc/balancer/roundrobin"
	"google.golang.org/grpc/codes"
	"google.golang.org/grpc/credentials"
	"google.golang.org/grpc/status"

	authorization "messenger/ws/internal/generated/grpc"
	"messenger/ws/internal/roomname"
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
	ExpiresAt time.Time
}

type TLSConfig struct {
	CAFile     string
	CertFile   string
	KeyFile    string
	ServerName string
}

func New(address string, config TLSConfig) (*Client, error) {
	if strings.TrimSpace(config.ServerName) == "" {
		return nil, errors.New("gRPC TLS server name is required")
	}
	ca, err := os.ReadFile(config.CAFile)
	if err != nil {
		return nil, fmt.Errorf("gRPC TLS CA: %w", err)
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(ca) {
		return nil, errors.New("gRPC TLS CA contains no certificates")
	}
	certificate, err := tls.LoadX509KeyPair(config.CertFile, config.KeyFile)
	if err != nil {
		return nil, fmt.Errorf("gRPC TLS client certificate: %w", err)
	}
	transport := credentials.NewTLS(&tls.Config{
		MinVersion:   tls.VersionTLS12,
		RootCAs:      roots,
		Certificates: []tls.Certificate{certificate},
		ServerName:   config.ServerName,
	})
	connection, err := grpc.NewClient(address,
		grpc.WithTransportCredentials(transport),
		grpc.WithDefaultServiceConfig(`{"loadBalancingConfig":[{"round_robin":{}}]}`),
	)
	if err != nil {
		return nil, fmt.Errorf("gRPC connection: %w", err)
	}
	return &Client{connection: connection, service: authorization.NewChatAuthorizationClient(connection)}, nil
}

func (c *Client) AuthorizeGroup(ctx context.Context, sessionID, chatID string) (string, error) {
	response, err := c.service.AuthorizeGroup(ctx, &authorization.AuthorizeGroupRequest{ChatId: chatID, SessionId: sessionID})
	if err != nil {
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unauthenticated || code == codes.NotFound || code == codes.InvalidArgument {
			return "", ErrUnauthorized
		}
		return "", fmt.Errorf("authorize group: %w", err)
	}
	if response.GetRoom() != roomname.Group(chatID) {
		return "", errors.New("invalid group authorization response")
	}
	return response.GetRoom(), nil
}

func (c *Client) AuthorizeGroups(ctx context.Context, sessionID string, chatIDs []string) (map[string]bool, error) {
	response, err := c.service.AuthorizeGroups(ctx, &authorization.AuthorizeGroupsRequest{ChatIds: chatIDs, SessionId: sessionID})
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

func (c *Client) ValidateSession(ctx context.Context, sessionID string) (Session, error) {
	response, err := c.service.ValidateSession(ctx, &authorization.ValidateSessionRequest{SessionId: sessionID})
	if err != nil {
		if code := status.Code(err); code == codes.PermissionDenied || code == codes.Unauthenticated || code == codes.NotFound || code == codes.InvalidArgument {
			return Session{}, ErrUnauthorized
		}
		return Session{}, fmt.Errorf("validate session: %w", err)
	}
	return decodeSession(response)
}

func (c *Client) ValidateSessions(ctx context.Context, sessionIDs []string) (map[string]Session, error) {
	response, err := c.service.ValidateSessions(ctx, &authorization.ValidateSessionsRequest{SessionIds: sessionIDs})
	if err != nil {
		return nil, fmt.Errorf("validate sessions: %w", err)
	}
	requested := make(map[string]bool, len(sessionIDs))
	for _, id := range sessionIDs {
		requested[id] = true
	}
	sessions := make(map[string]Session, len(response.GetSessions()))
	for _, item := range response.GetSessions() {
		session, err := decodeSession(item)
		if err != nil {
			return nil, err
		}
		if _, seen := sessions[session.SessionID]; seen || !requested[session.SessionID] {
			return nil, errors.New("invalid session validation response")
		}
		sessions[session.SessionID] = session
	}
	return sessions, nil
}

func decodeSession(response *authorization.ValidateSessionResponse) (Session, error) {
	if response.GetUserId() == "" || response.GetDeviceId() == "" || response.GetSessionId() == "" || response.GetExpiresAtUnixSeconds() <= 0 {
		return Session{}, errors.New("invalid session validation response")
	}
	return Session{
		UserID:    response.GetUserId(),
		DeviceID:  response.GetDeviceId(),
		SessionID: response.GetSessionId(),
		ExpiresAt: time.Unix(response.GetExpiresAtUnixSeconds(), 0),
	}, nil
}

func (c *Client) Close() error { return c.connection.Close() }

