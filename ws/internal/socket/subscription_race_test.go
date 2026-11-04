package socket

import (
	"context"
	"errors"
	"testing"
	"time"

	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/roomname"
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

func newRaceConnection(t *testing.T, rooms RoomCoordinator, authorize groupAuthorizerFunc, configure ...func(*Server)) *Connection {
	t.Helper()
	dependencies := testDependencies(rooms)
	if authorize != nil {
		dependencies.GroupAuthorizer = authorize
	}
	server := newTestServer(t, config.Config{MaxGroupAuths: 8, QueueItems: 8, QueueBytes: 4096, PendingACKLimit: 8, MaxRoomsPerConnection: 200, SubscribeRate: 10, SubscribeWindow: time.Second, ACKTimeout: time.Second, APITimeout: time.Second, GroupLease: time.Minute}, dependencies)
	for _, apply := range configure {
		apply(server)
	}
	connection := newConnection(server, nil, ticket.Identity{UserID: raceChatID}, "")
	t.Cleanup(connection.Close)
	return connection
}

func TestRemovalDuringAuthorizationRejectsJoin(t *testing.T) {
	rooms := &raceRooms{}
	var connection *Connection
	authorize := groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		connection.Enqueue(protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.User(raceChatID), ChatID: raceChatID, MemberID: raceChatID})
		return "group:" + raceChatID, nil
	})
	connection = newRaceConnection(t, rooms, authorize)
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: protocol.ChatGroup, ChatID: raceChatID})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || rooms.joins != 0 {
		t.Fatalf("join after removal: error=%v joins=%d", err, rooms.joins)
	}
}

func TestRemovalDuringRedisJoinLeavesRoomAndBlocksFanout(t *testing.T) {
	rooms := &raceRooms{}
	authorize := groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		return "group:" + raceChatID, nil
	})
	connection := newRaceConnection(t, rooms, authorize)
	rooms.onJoin = func() {
		connection.Enqueue(protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.User(raceChatID), ChatID: raceChatID, MemberID: raceChatID})
	}
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: protocol.ChatGroup, ChatID: raceChatID})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || rooms.joins != 1 || rooms.leaves != 1 {
		t.Fatalf("join after removal: error=%v joins=%d leaves=%d", err, rooms.joins, rooms.leaves)
	}
	before := len(connection.out)
	connection.Enqueue(protocol.Event{Type: "message_saved", Room: "group:" + raceChatID, ChatID: raceChatID})
	if got := len(connection.out); got != before {
		t.Fatalf("queued %d group frames after removal, want %d", got, before)
	}
}

func TestGroupJoinReauthorizesAfterFeedAttach(t *testing.T) {
	rooms := &raceRooms{}
	calls := 0
	authorize := groupAuthorizerFunc(func(_ context.Context, _, _ string) (string, error) {
		calls++
		if calls == 2 {
			return "", grpcauth.ErrUnauthorized
		}
		return roomname.Group(raceChatID), nil
	})
	connection := newRaceConnection(t, rooms, authorize)
	rooms.onJoin = func() {
		connection.Enqueue(protocol.Event{Type: protocol.EventMessageSaved, Room: roomname.Group(raceChatID), ChatID: raceChatID})
	}
	err := connection.handle(protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || calls != 2 || rooms.joins != 1 || rooms.leaves != 1 || len(connection.out) != 0 {
		t.Fatalf("join after removal: error=%v authorizations=%d joins=%d leaves=%d queued=%d", err, calls, rooms.joins, rooms.leaves, len(connection.out))
	}
}

func TestGroupJoinRequestsRecoveryForFramesHeldDuringAuthorization(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(_ context.Context, _, _ string) (string, error) {
		return roomname.Group(raceChatID), nil
	}))
	rooms.onJoin = func() {
		connection.Enqueue(protocol.Event{Type: protocol.EventMessageSaved, Room: roomname.Group(raceChatID), ChatID: raceChatID})
	}
	if err := connection.handle(protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID}); err != nil {
		t.Fatal(err)
	}
	if len(connection.out) != 2 {
		t.Fatalf("queued events = %d, want recovery_failed and subscribed", len(connection.out))
	}
	first, second := <-connection.out, <-connection.out
	if first.frame.Event().Type != protocol.EventRecoveryFailed || second.frame.Event().Type != protocol.EventSubscribed {
		t.Fatalf("queued events = %s, %s", first.frame.Event().Type, second.frame.Event().Type)
	}
}

func TestGroupRemovalDuringSecondAuthorizationCannotActivateGrant(t *testing.T) {
	rooms := &raceRooms{}
	calls := 0
	var connection *Connection
	authorize := groupAuthorizerFunc(func(_ context.Context, _, _ string) (string, error) {
		calls++
		if calls == 2 {
			connection.Enqueue(protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.Group(raceChatID), ChatID: raceChatID, MemberID: raceChatID})
		}
		return roomname.Group(raceChatID), nil
	})
	connection = newRaceConnection(t, rooms, authorize)
	err := connection.handle(protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || calls != 2 || rooms.leaves != 1 || connection.subscriptions.room(raceChatID) != "" || len(connection.out) != 0 {
		t.Fatalf("group grant after removal: error=%v authorizations=%d leaves=%d queued=%d", err, calls, rooms.leaves, len(connection.out))
	}
}

func TestGroupRemovalRevokesRemovedMemberAndNotifiesRemainingMembers(t *testing.T) {
	rooms := &raceRooms{}
	authorize := groupAuthorizerFunc(func(_ context.Context, _, _ string) (string, error) {
		return roomname.Group(raceChatID), nil
	})
	removed := newRaceConnection(t, rooms, authorize)
	other := newRaceConnection(t, rooms, authorize)
	other.session.UserID = secondRaceChatID
	frame := protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID}
	for _, connection := range []*Connection{removed, other} {
		if err := connection.handle(frame); err != nil {
			t.Fatal(err)
		}
	}
	removedBefore, otherBefore := len(removed.out), len(other.out)
	event := protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.Group(raceChatID), ChatID: raceChatID, MemberID: raceChatID}
	removed.Enqueue(event)
	other.Enqueue(event)
	if removed.subscriptions.room(raceChatID) != "" || other.subscriptions.room(raceChatID) == "" || len(removed.out) != removedBefore || len(other.out) != otherBefore+1 {
		t.Fatal("group removal did not revoke only the removed member and notify the remaining member")
	}
	<-other.out
	got := <-other.out
	notification := got.frame.Event()
	if notification.Type != protocol.EventMemberRemoved || notification.Room != event.Room || notification.ChatID != event.ChatID || notification.MemberID != event.MemberID || got.groupGrant == nil {
		t.Fatalf("remaining member notification = %+v, want group-authorized removal event", notification)
	}
	removed.Close()
	other.Close()
}

func TestDirectJoinAfterCloseLeavesRoom(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		t.Fatal("direct Chat should not require group authorization")
		return "", nil
	}))
	rooms.onJoin = connection.Close
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: protocol.ChatDirect, ChatID: raceChatID})
	if !errors.Is(err, context.Canceled) || rooms.joins != 1 || rooms.leaves != 1 {
		t.Fatalf("join after close: error=%v joins=%d leaves=%d", err, rooms.joins, rooms.leaves)
	}
}

func TestClosedConnectionCannotRenewDirectChat(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		t.Fatal("direct Chat should not require group authorization")
		return "", nil
	}))
	frame := protocol.Frame{Type: "subscribe", Kind: protocol.ChatDirect, ChatID: raceChatID}
	if err := connection.handle(frame); err != nil {
		t.Fatal(err)
	}
	connection.Close()
	if err := connection.handle(frame); !errors.Is(err, context.Canceled) || rooms.joins != 1 {
		t.Fatalf("renew after close: error=%v joins=%d", err, rooms.joins)
	}
}

func TestSubscriptionLimitRunsBeforeGroupAuthorizationAndJoin(t *testing.T) {
	rooms := &raceRooms{}
	authorize := groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		t.Fatal("group authorization called after subscription was limited")
		return "", nil
	})
	limiter := &rejectingSubscribeLimiter{}
	connection := newRaceConnection(t, rooms, authorize, func(server *Server) { server.subscribeLimiter = limiter })
	connection.session.UserID = raceChatID
	err := connection.handle(protocol.Frame{Type: "subscribe", Kind: protocol.ChatGroup, ChatID: raceChatID})
	if !errors.Is(err, errRateLimited) || limiter.calls != 1 || rooms.joins != 0 {
		t.Fatalf("limited subscription: error=%v limiter calls=%d room joins=%d", err, limiter.calls, rooms.joins)
	}
}

func TestSubscribeManyAuthorizesGroupsBeforeAndAfterJoining(t *testing.T) {
	rooms := &raceRooms{}
	authorizer := &recordingBatchAuthorizer{allowed: map[string]bool{raceChatID: true, secondRaceChatID: true}}
	connection := newRaceConnection(t, rooms, nil, func(server *Server) { server.groupAuth = authorizer })
	err := connection.handle(protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{
		{ChatID: raceChatID, Kind: protocol.ChatGroup}, {ChatID: secondRaceChatID, Kind: protocol.ChatGroup},
	}})
	if err != nil || authorizer.calls != 2 || rooms.joins != 2 {
		t.Fatalf("batch join: error=%v API calls=%d joins=%d", err, authorizer.calls, rooms.joins)
	}
	connection.Close()
}

func TestSubscribeManyRejectsPartialAuthorizationBeforeJoining(t *testing.T) {
	rooms := &raceRooms{}
	authorizer := &recordingBatchAuthorizer{allowed: map[string]bool{raceChatID: true}}
	connection := newRaceConnection(t, rooms, nil, func(server *Server) { server.groupAuth = authorizer })
	err := connection.handle(protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{
		{ChatID: raceChatID, Kind: protocol.ChatGroup}, {ChatID: secondRaceChatID, Kind: protocol.ChatGroup},
	}})
	if !errors.Is(err, grpcauth.ErrUnauthorized) || authorizer.calls != 1 || rooms.joins != 0 {
		t.Fatalf("partially denied batch: error=%v API calls=%d joins=%d", err, authorizer.calls, rooms.joins)
	}
	connection.Close()
}

func TestSubscribeManyChargesRateLimitOnceBeforeAuthorization(t *testing.T) {
	rooms := &raceRooms{}
	limiter := &rejectingSubscribeLimiter{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
		t.Fatal("authorization called after batch was limited")
		return "", nil
	}), func(server *Server) { server.subscribeLimiter = limiter })
	err := connection.handle(protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{
		{ChatID: raceChatID, Kind: protocol.ChatGroup}, {ChatID: secondRaceChatID, Kind: protocol.ChatGroup},
	}})
	if !errors.Is(err, errRateLimited) || limiter.calls != 1 || rooms.joins != 0 {
		t.Fatalf("limited batch: error=%v limiter calls=%d joins=%d", err, limiter.calls, rooms.joins)
	}
	connection.Close()
}

func TestSubscriptionRoomLimitPrecedesGroupAuthorization(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "batch"}[batch], func(t *testing.T) {
			rooms := &raceRooms{}
			connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) {
				t.Fatal("group authorization called after room limit")
				return "", nil
			}), func(server *Server) { server.config.MaxRoomsPerConnection = 1 })
			if err := connection.handle(protocol.Frame{Type: "subscribe", Kind: protocol.ChatDirect, ChatID: raceChatID}); err != nil {
				t.Fatal(err)
			}
			frame := protocol.Frame{Type: "subscribe", Kind: protocol.ChatGroup, ChatID: secondRaceChatID}
			if batch {
				frame = protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{{ChatID: secondRaceChatID, Kind: protocol.ChatGroup}}}
			}
			if err := connection.handle(frame); !errors.Is(err, errRoomLimit) || rooms.joins != 1 {
				t.Fatalf("room limit: error=%v joins=%d", err, rooms.joins)
			}
			connection.Close()
		})
	}
}

func TestDeniedGroupRenewalLeavesJoinedRoom(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(map[bool]string{false: "single", true: "batch"}[batch], func(t *testing.T) {
			rooms := &raceRooms{}
			allowed := true
			authorizer := groupAuthorizerFunc(func(_ context.Context, _, chatID string) (string, error) {
				if !allowed {
					return "", grpcauth.ErrUnauthorized
				}
				return "group:" + chatID, nil
			})
			batchAuthorizer := &recordingBatchAuthorizer{allowed: map[string]bool{raceChatID: true}}
			frame := protocol.Frame{Type: "subscribe", Kind: protocol.ChatGroup, ChatID: raceChatID}
			var connection *Connection
			if batch {
				connection = newRaceConnection(t, rooms, authorizer, func(server *Server) { server.groupAuth = batchAuthorizer })
				frame = protocol.Frame{Type: "subscribe_many", Subscriptions: []protocol.Subscription{{ChatID: raceChatID, Kind: protocol.ChatGroup}}}
			} else {
				connection = newRaceConnection(t, rooms, authorizer)
			}
			if err := connection.handle(frame); err != nil {
				t.Fatal(err)
			}
			allowed = false
			batchAuthorizer.allowed[raceChatID] = false
			if err := connection.handle(frame); !errors.Is(err, grpcauth.ErrUnauthorized) || rooms.leaves != 1 {
				t.Fatalf("denied renewal: error=%v leaves=%d", err, rooms.leaves)
			}
			connection.Close()
		})
	}
}
