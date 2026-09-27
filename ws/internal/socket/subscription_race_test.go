package socket

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/ticket"
)

const raceChatID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
const secondRaceChatID = "01ARZ3NDEKTSV4RRFFQ69G5FAW"

type recordingBatchAuthorizer struct {
	calls   int
	allowed map[string]bool
}

func (authorizer *recordingBatchAuthorizer) AuthorizeGroup(_ context.Context, _, chatID string) (string, error) {
	return "group:" + chatID, nil
}

func (authorizer *recordingBatchAuthorizer) AuthorizeGroups(_ context.Context, _ string, chatIDs []string) (map[string]bool, error) {
	authorizer.calls++
	return authorizer.allowed, nil
}

type groupAuthorizerFunc func(context.Context, string, string) (string, error)

func (fn groupAuthorizerFunc) AuthorizeGroup(ctx context.Context, token, chatID string) (string, error) {
	return fn(ctx, token, chatID)
}

func (fn groupAuthorizerFunc) AuthorizeGroups(ctx context.Context, token string, chatIDs []string) (map[string]bool, error) {
	allowed := make(map[string]bool, len(chatIDs))
	for _, chatID := range chatIDs {
		if _, err := fn(ctx, token, chatID); err != nil {
			return nil, err
		}
		allowed[chatID] = true
	}
	return allowed, nil
}

type rejectingSubscribeLimiter struct{ calls int }

func (limiter *rejectingSubscribeLimiter) AllowSubscribe(context.Context, string, int, time.Duration) (bool, error) {
	limiter.calls++
	return false, nil
}

func (limiter *rejectingSubscribeLimiter) AllowSubscribeBatch(_ context.Context, _ string, _, _ int, _ time.Duration) (bool, error) {
	limiter.calls++
	return false, nil
}

type raceRooms struct {
	onJoin func()
	joins  int
	leaves int
}

func (rooms *raceRooms) Join(_ context.Context, _ roomregistry.Recipient, _, _, _, _ string) error {
	rooms.joins++
	if rooms.onJoin != nil {
		rooms.onJoin()
	}
	return nil
}
func (*raceRooms) LeaveAll(roomregistry.Recipient)                        {}
func (rooms *raceRooms) LeaveChat(roomregistry.Recipient, string, string) { rooms.leaves++ }
func (*raceRooms) RunChecks(context.Context)                              {}
func (*raceRooms) Close()                                                 {}

func newRaceConnection(t *testing.T, rooms *raceRooms, authorize groupAuthorizerFunc) *Connection {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	metrics := monitoring.New(prometheus.NewRegistry())
	server := &Server{
		config: config.Config{QueueItems: 8, QueueBytes: 4096, PendingACKLimit: 8, MaxRoomsPerConnection: 200, SubscribeRate: 10, SubscribeWindow: time.Second, ACKTimeout: time.Second, APITimeout: time.Second, GroupLease: time.Minute},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), groupAuth: authorize, rooms: rooms, metrics: metrics,
		ctx: ctx, cancel: cancel, connections: make(map[*Connection]struct{}),
	}
	return newConnection(server, nil, ticket.Identity{}, "ticket")
}

func TestRemovalDuringAuthorizationRejectsJoin(t *testing.T) {
	rooms := &raceRooms{}
	var connection *Connection
	authorize := groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		connection.Enqueue(protocol.Event{Type: "member_removed", ChatID: raceChatID})
		return "group:" + raceChatID, nil
	})
	connection = newRaceConnection(t, rooms, authorize)
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: "group", ChatID: raceChatID})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || rooms.joins != 0 || connection.room(raceChatID) != "" {
		t.Fatalf("join after removal: error=%v joins=%d room=%q", err, rooms.joins, connection.room(raceChatID))
	}
}

func TestRemovalDuringRedisJoinLeavesRoomAndBlocksFanout(t *testing.T) {
	rooms := &raceRooms{}
	authorize := groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		return "group:" + raceChatID, nil
	})
	connection := newRaceConnection(t, rooms, authorize)
	rooms.onJoin = func() { connection.Enqueue(protocol.Event{Type: "member_removed", ChatID: raceChatID}) }
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: "group", ChatID: raceChatID})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || rooms.joins != 1 || rooms.leaves != 1 || connection.room(raceChatID) != "" {
		t.Fatalf("join after removal: error=%v joins=%d leaves=%d room=%q", err, rooms.joins, rooms.leaves, connection.room(raceChatID))
	}
	before := len(connection.out)
	connection.Enqueue(protocol.Event{Type: "message_saved", Room: "group:" + raceChatID, ChatID: raceChatID})
	if got := len(connection.out); got != before {
		t.Fatalf("queued %d group frames after removal, want %d", got, before)
	}
}

func TestSubscriptionLimitRunsBeforeGroupAuthorizationAndJoin(t *testing.T) {
	rooms := &raceRooms{}
	authorize := groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		t.Fatal("group authorization called after subscription was limited")
		return "", nil
	})
	connection := newRaceConnection(t, rooms, authorize)
	limiter := &rejectingSubscribeLimiter{}
	connection.server.subscribeLimiter = limiter
	connection.session.UserID = raceChatID
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: "group", ChatID: raceChatID})
	if !errors.Is(err, errRateLimited) || limiter.calls != 1 || rooms.joins != 0 {
		t.Fatalf("limited subscription: error=%v limiter calls=%d room joins=%d", err, limiter.calls, rooms.joins)
	}
}

func TestSubscribeManyAuthorizesGroupsOnceBeforeJoining(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(_ context.Context, _, chatID string) (string, error) { return "group:" + chatID, nil }))
	authorizer := &recordingBatchAuthorizer{allowed: map[string]bool{raceChatID: true, secondRaceChatID: true}}
	connection.server.groupAuth = authorizer
	err := connection.handle(protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{
		{ChatID: raceChatID, Kind: "group"}, {ChatID: secondRaceChatID, Kind: "group"},
	}})
	if err != nil || authorizer.calls != 1 || rooms.joins != 2 {
		t.Fatalf("batch join: error=%v API calls=%d joins=%d", err, authorizer.calls, rooms.joins)
	}
	connection.Close()
}

func TestSubscribeManyRejectsPartialAuthorizationBeforeJoining(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(_ context.Context, _, chatID string) (string, error) { return "group:" + chatID, nil }))
	authorizer := &recordingBatchAuthorizer{allowed: map[string]bool{raceChatID: true}}
	connection.server.groupAuth = authorizer
	err := connection.handle(protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{
		{ChatID: raceChatID, Kind: "group"}, {ChatID: secondRaceChatID, Kind: "group"},
	}})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || authorizer.calls != 1 || rooms.joins != 0 {
		t.Fatalf("partially denied batch: error=%v API calls=%d joins=%d", err, authorizer.calls, rooms.joins)
	}
	connection.Close()
}

func TestSubscribeManyChargesRateLimitOnceBeforeAuthorization(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		t.Fatal("authorization called after batch was limited")
		return "", nil
	}))
	limiter := &rejectingSubscribeLimiter{}
	connection.server.subscribeLimiter = limiter
	err := connection.handle(protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{
		{ChatID: raceChatID, Kind: "group"}, {ChatID: secondRaceChatID, Kind: "group"},
	}})
	if !errors.Is(err, errRateLimited) || limiter.calls != 1 || rooms.joins != 0 {
		t.Fatalf("limited batch: error=%v limiter calls=%d joins=%d", err, limiter.calls, rooms.joins)
	}
	connection.Close()
}
