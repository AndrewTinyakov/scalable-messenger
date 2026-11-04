package socket

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
	"messenger/ws/internal/ticket"
)

func TestExpiredConnectionReleasesAdmissionLease(t *testing.T) {
	base := newRaceConnection(t, &raceRooms{}, nil)
	t.Cleanup(base.Close)
	leases := &trackingConnectionLeases{release: make(chan struct{}, 1)}
	base.server.connectionLeases = leases
	connection := newConnection(base.server, nil, ticket.Identity{UserID: sessionTestUser, ExpiresAt: time.Now().Add(-time.Second)}, "expired-lease")
	select {
	case <-connection.ctx.Done():
	case <-time.After(time.Second):
		t.Fatal("expired connection did not close")
	}
	connection.Close()
	connection.Close()
	select {
	case <-leases.release:
	case <-time.After(time.Second):
		t.Fatal("expired connection did not release its admission lease")
	}
	if _, got := leases.counts(); got != 1 {
		t.Fatalf("released leases = %d, want 1", got)
	}
}

func TestExpiredConnectionClosesDuringConstruction(t *testing.T) {
	base := newRaceConnection(t, &raceRooms{}, nil)
	t.Cleanup(base.Close)
	for range 100 {
		connection := newConnection(base.server, nil, ticket.Identity{ExpiresAt: time.Now().Add(-time.Second)}, "")
		select {
		case <-connection.ctx.Done():
		case <-time.After(time.Second):
			t.Fatal("expired connection did not close")
		}
		connection.Close()
	}
}

func TestExpiredAdmissionDeniesGroupOperationsBeforeRPC(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "batch"}[batch], func(t *testing.T) {
			rooms := &raceRooms{}
			connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
				t.Error("expired admission started an authorization RPC")
				return roomname.Group(raceChatID), nil
			}))
			connection.session.ExpiresAt = time.Now().Add(-time.Second)
			frame := protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID}
			if batch {
				frame = protocol.Frame{Type: protocol.FrameSubscribeMany, Subscriptions: []protocol.Subscription{{ChatID: raceChatID, Kind: protocol.ChatGroup}}}
			}
			if err := connection.handle(frame); !errors.Is(err, grpcauth.ErrUnauthorized) || rooms.joins != 0 || len(connection.out) != 0 {
				t.Fatalf("expired admission: error=%v joins=%d queued=%d", err, rooms.joins, len(connection.out))
			}
		})
	}
}

func TestAdmissionExpiryDuringGroupAuthorizationDiscardsResult(t *testing.T) {
	for _, batch := range []bool{false, true} {
		for _, expiresOnCall := range []int{1, 2} {
			name := fmt.Sprintf("batch=%t/call=%d", batch, expiresOnCall)
			t.Run(name, func(t *testing.T) {
				rooms := &raceRooms{}
				var connection *Connection
				calls := 0
				connection = newRaceConnection(t, rooms, groupAuthorizerFunc(func(_ context.Context, sessionID, chatID string) (string, error) {
					calls++
					if sessionID != connection.session.SessionID {
						t.Fatalf("authorization used session %q", sessionID)
					}
					if calls == expiresOnCall {
						connection.session.ExpiresAt = time.Now().Add(-time.Second)
					}
					return roomname.Group(chatID), nil
				}))
				connection.session.SessionID = strings.Repeat("a", 64)
				connection.session.ExpiresAt = time.Now().Add(time.Hour)
				frame := protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID}
				if batch {
					frame = protocol.Frame{Type: protocol.FrameSubscribeMany, Subscriptions: []protocol.Subscription{{ChatID: raceChatID, Kind: protocol.ChatGroup}}}
				}
				err := connection.handle(frame)
				if !errors.Is(err, grpcauth.ErrUnauthorized) || calls != expiresOnCall || rooms.joins != expiresOnCall-1 || rooms.leaves != rooms.joins || connection.subscriptions.room(raceChatID) != "" || len(connection.out) != 0 {
					t.Fatalf("late authorization: error=%v calls=%d joins=%d leaves=%d queued=%d", err, calls, rooms.joins, rooms.leaves, len(connection.out))
				}
			})
		}
	}
}
