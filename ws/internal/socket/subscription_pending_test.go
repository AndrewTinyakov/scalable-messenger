package socket

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/roomname"
)

type pendingBatchAuthorizer struct {
	calls       int
	singleCalls int
	onBatch     func(context.Context, int, []string) (map[string]bool, error)
}

func (authorizer *pendingBatchAuthorizer) AuthorizeGroup(context.Context, string, string) (string, error) {
	authorizer.singleCalls++
	return "", errors.New("batch called single group authorization")
}

func (authorizer *pendingBatchAuthorizer) AuthorizeGroups(ctx context.Context, _ string, ids []string) (map[string]bool, error) {
	authorizer.calls++
	if authorizer.onBatch != nil {
		return authorizer.onBatch(ctx, authorizer.calls, ids)
	}
	return allowBatch(ids), nil
}

func allowBatch(ids []string) map[string]bool {
	allowed := make(map[string]bool, len(ids))
	for _, id := range ids {
		allowed[id] = true
	}
	return allowed
}

type pendingJoin struct {
	recipient roomregistry.Recipient
	room      string
	chatID    string
	epoch     string
	streamID  string
}

type pendingBatchRooms struct {
	mu     sync.Mutex
	joins  []pendingJoin
	active map[roomregistry.Recipient]map[string]bool
	onJoin func(context.Context, pendingJoin) error
}

func (rooms *pendingBatchRooms) Join(ctx context.Context, recipient roomregistry.Recipient, room, chatID, epoch, streamID string) error {
	join := pendingJoin{recipient: recipient, room: room, chatID: chatID, epoch: epoch, streamID: streamID}
	rooms.mu.Lock()
	rooms.joins = append(rooms.joins, join)
	if rooms.active == nil {
		rooms.active = make(map[roomregistry.Recipient]map[string]bool)
	}
	if rooms.active[recipient] == nil {
		rooms.active[recipient] = make(map[string]bool)
	}
	rooms.active[recipient][chatID] = true
	rooms.mu.Unlock()
	if rooms.onJoin != nil {
		return rooms.onJoin(ctx, join)
	}
	return nil
}

func (rooms *pendingBatchRooms) LeaveChat(recipient roomregistry.Recipient, _, chatID string) {
	rooms.mu.Lock()
	defer rooms.mu.Unlock()
	delete(rooms.active[recipient], chatID)
	if len(rooms.active[recipient]) == 0 {
		delete(rooms.active, recipient)
	}
}

func (rooms *pendingBatchRooms) LeaveAll(recipient roomregistry.Recipient) {
	rooms.mu.Lock()
	defer rooms.mu.Unlock()
	delete(rooms.active, recipient)
}

func (*pendingBatchRooms) RunChecks(context.Context) {}
func (*pendingBatchRooms) Close()                    {}

func newPendingBatchConnection(t *testing.T, rooms *pendingBatchRooms, authorizer *pendingBatchAuthorizer) *Connection {
	return newRaceConnection(t, rooms, nil, func(server *Server) {
		server.groupAuth = authorizer
	})
}

func pendingBatchItems() []protocol.Subscription {
	return []protocol.Subscription{
		{ChatID: raceChatID, Kind: protocol.ChatGroup, Epoch: "epoch-1", StreamID: "9-1"},
		{ChatID: secondRaceChatID, Kind: protocol.ChatGroup, Epoch: "epoch-2", StreamID: "8-2"},
	}
}

func TestGroupFeedFailureClosesCurrentPendingAndActiveGrants(t *testing.T) {
	for _, pending := range []bool{true, false} {
		t.Run(map[bool]string{true: "pending", false: "active"}[pending], func(t *testing.T) {
			rooms := &pendingBatchRooms{}
			connection := newPendingBatchConnection(t, rooms, &pendingBatchAuthorizer{})
			closeRecipient := func(recipient roomregistry.Recipient) {
				closer, ok := recipient.(interface{ Close() })
				if !ok {
					t.Fatal("group recipient cannot close after a feed continuity failure")
				}
				closer.Close()
			}
			if pending {
				rooms.onJoin = func(_ context.Context, join pendingJoin) error {
					closeRecipient(join.recipient)
					return nil
				}
			}
			err := connection.subscriptions.subscribeMany(pendingBatchItems())
			if pending && err == nil {
				t.Fatal("pending feed failure permitted subscription activation")
			}
			if !pending {
				if err != nil {
					t.Fatal(err)
				}
				closeRecipient(rooms.joins[0].recipient)
			}
			if connection.state == lifecycleActive || connection.ctx.Err() == nil || len(rooms.active) != 0 {
				t.Fatal("feed failure did not close the connection and release its rooms")
			}
		})
	}
}

func TestStaleGroupFeedFailureDoesNotCloseReplacementGrant(t *testing.T) {
	rooms := &pendingBatchRooms{}
	connection := newPendingBatchConnection(t, rooms, &pendingBatchAuthorizer{})
	items := pendingBatchItems()[:1]
	if err := connection.subscriptions.subscribeMany(items); err != nil {
		t.Fatal(err)
	}
	old := rooms.joins[0].recipient
	connection.subscriptions.leave(items[0].ChatID)
	if err := connection.subscriptions.subscribeMany(items); err != nil {
		t.Fatal(err)
	}
	closer, ok := old.(interface{ Close() })
	if !ok {
		t.Fatal("group recipient cannot close after a feed continuity failure")
	}
	closer.Close()
	if connection.state == lifecycleClosed || connection.ctx.Err() != nil || connection.subscriptions.room(items[0].ChatID) == "" {
		t.Fatal("stale feed failure closed a replacement subscription")
	}
}

func assertNoPendingFeeds(t *testing.T, connection *Connection, rooms *pendingBatchRooms) {
	t.Helper()
	rooms.mu.Lock()
	count := len(rooms.active)
	rooms.mu.Unlock()
	if count != 0 || len(connection.subscriptions.groups) != 0 || len(connection.subscriptions.rooms) != 0 || len(connection.subscriptions.leases) != 0 {
		t.Fatalf("failed batch retained feeds=%d groups=%d rooms=%d leases=%d", count, len(connection.subscriptions.groups), len(connection.subscriptions.rooms), len(connection.subscriptions.leases))
	}
	before := len(connection.out)
	for _, join := range rooms.joins {
		if !roomname.IsGroup(join.room) {
			continue
		}
		join.recipient.Enqueue(protocol.Event{Type: protocol.EventMessageSaved, Room: join.room, ChatID: join.chatID})
	}
	if len(connection.out) != before {
		t.Fatal("failed batch accepted a late callback")
	}
}

func TestSubscribeManyChecksMembershipTwiceForEntirePendingBatch(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	rooms.onJoin = func(_ context.Context, join pendingJoin) error {
		join.recipient.Enqueue(protocol.Event{Type: protocol.EventMessageSaved, Room: join.room, ChatID: join.chatID})
		join.recipient.Enqueue(protocol.Event{Type: protocol.EventRecoveryFailed, Room: join.room, ChatID: join.chatID})
		join.recipient.Enqueue(protocol.Event{Type: protocol.EventSubscribed, Room: join.room, ChatID: join.chatID})
		if len(connection.out) != 0 {
			t.Fatal("pending batch queued a group frame")
		}
		return nil
	}
	authorizer.onBatch = func(_ context.Context, call int, ids []string) (map[string]bool, error) {
		if len(ids) != 2 {
			t.Fatalf("authorization groups = %v", ids)
		}
		if call == 2 && (len(rooms.joins) != 2 || len(connection.out) != 0) {
			t.Fatal("final check ran before all feeds attached or after delivery")
		}
		return allowBatch(ids), nil
	}
	items := pendingBatchItems()
	if err := connection.subscriptions.subscribeMany(items); err != nil {
		t.Fatal(err)
	}
	if authorizer.calls != 2 || authorizer.singleCalls != 0 {
		t.Fatalf("batch RPCs=%d single RPCs=%d", authorizer.calls, authorizer.singleCalls)
	}
	for index, join := range rooms.joins {
		if join.epoch != items[index].Epoch || join.streamID != items[index].StreamID {
			t.Fatal("batch lost replay cursor")
		}
		for _, want := range []protocol.EventType{protocol.EventRecoveryFailed, protocol.EventSubscribed} {
			got := (<-connection.out).frame.Event()
			if got.Type != want || got.ChatID != join.chatID {
				t.Fatalf("batch event = %+v, want %s for %s", got, want, join.chatID)
			}
		}
	}
	connection.Close()
	if len(rooms.active) != 0 {
		t.Fatal("closed connection retained group feeds")
	}
}

func TestSubscribeManyRemovalAtEachAuthorizationStageCannotActivate(t *testing.T) {
	for _, stage := range []string{"before attach", "during attach", "final check"} {
		t.Run(stage, func(t *testing.T) {
			rooms := &pendingBatchRooms{}
			authorizer := &pendingBatchAuthorizer{}
			connection := newPendingBatchConnection(t, rooms, authorizer)
			remove := func() {
				connection.Enqueue(protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.Group(raceChatID), ChatID: raceChatID, MemberID: raceChatID})
			}
			authorizer.onBatch = func(_ context.Context, call int, ids []string) (map[string]bool, error) {
				if (stage == "before attach" && call == 1) || (stage == "final check" && call == 2) {
					remove()
				}
				return allowBatch(ids), nil
			}
			rooms.onJoin = func(_ context.Context, join pendingJoin) error {
				if stage == "during attach" && join.chatID == secondRaceChatID {
					remove()
				}
				return nil
			}
			if err := connection.subscriptions.subscribeMany(pendingBatchItems()); !errors.Is(err, grpcauth.ErrUnauthorized) {
				t.Fatalf("removed batch error = %v", err)
			}
			if len(connection.out) != 0 {
				t.Fatal("removed batch queued group frames")
			}
			assertNoPendingFeeds(t, connection, rooms)
		})
	}
}

func TestSubscribeManyFinalCheckFailureCleansEveryPendingFeed(t *testing.T) {
	for _, failure := range []string{"denied membership", "revoked session", "expired admission", "canceled request", "authorization failure"} {
		t.Run(failure, func(t *testing.T) {
			rooms := &pendingBatchRooms{}
			authorizer := &pendingBatchAuthorizer{}
			connection := newPendingBatchConnection(t, rooms, authorizer)
			base, cancel := context.WithCancel(connection.ctx)
			defer cancel()
			expected := grpcauth.ErrUnauthorized
			authorizer.onBatch = func(_ context.Context, call int, ids []string) (map[string]bool, error) {
				allowed := allowBatch(ids)
				if call == 1 {
					return allowed, nil
				}
				switch failure {
				case "denied membership":
					allowed[secondRaceChatID] = false
				case "revoked session":
					return nil, grpcauth.ErrUnauthorized
				case "expired admission":
					connection.authorizedUntil.Store(time.Now().Add(-time.Second).UnixNano())
				case "canceled request":
					cancel()
					expected = context.Canceled
				case "authorization failure":
					expected = errors.New("RPC unavailable")
					return nil, expected
				}
				return allowed, nil
			}
			if err := connection.subscriptions.subscribeContext(base, pendingBatchItems(), batchSubscription); !errors.Is(err, expected) {
				t.Fatalf("failed final check = %v, want %v", err, expected)
			}
			if authorizer.calls != 2 || len(rooms.joins) != 2 || len(connection.out) != 0 {
				t.Fatalf("calls=%d joins=%d queued=%d", authorizer.calls, len(rooms.joins), len(connection.out))
			}
			assertNoPendingFeeds(t, connection, rooms)
		})
	}
}

func TestSubscribeManyFeedFailureCleansAttachedAndPartiallyAttachedFeeds(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	failed := errors.New("feed capacity reached")
	rooms.onJoin = func(_ context.Context, join pendingJoin) error {
		if join.chatID == secondRaceChatID {
			return failed
		}
		return nil
	}
	items := append([]protocol.Subscription{{ChatID: "direct-chat", Kind: protocol.ChatDirect}}, pendingBatchItems()...)
	if err := connection.subscriptions.subscribeMany(items); !errors.Is(err, failed) {
		t.Fatalf("partial batch error = %v", err)
	}
	if authorizer.calls != 1 || len(rooms.joins) != 3 {
		t.Fatalf("calls=%d joins=%d", authorizer.calls, len(rooms.joins))
	}
	assertNoPendingFeeds(t, connection, rooms)
}

func TestSubscribeManyOldFeedCallbacksCannotAffectRejoinedGrant(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	items := pendingBatchItems()[:1]
	if err := connection.subscriptions.subscribeMany(items); err != nil {
		t.Fatal(err)
	}
	<-connection.out
	old := rooms.joins[0]
	connection.subscriptions.revoke(raceChatID)
	rooms.onJoin = func(_ context.Context, _ pendingJoin) error {
		for _, event := range []protocol.Event{
			{Type: protocol.EventMessageSaved, Room: old.room, ChatID: old.chatID},
			{Type: protocol.EventRecoveryFailed, Room: old.room, ChatID: old.chatID},
			{Type: protocol.EventMemberRemoved, Room: old.room, ChatID: old.chatID, MemberID: raceChatID},
		} {
			old.recipient.Enqueue(event)
		}
		return nil
	}
	if err := connection.subscriptions.subscribeMany(items); err != nil {
		t.Fatal(err)
	}
	if len(connection.out) != 1 || (<-connection.out).frame.Event().Type != protocol.EventSubscribed {
		t.Fatal("stale callbacks affected replacement grant")
	}
	rooms.onJoin(context.Background(), pendingJoin{})
	if connection.subscriptions.room(raceChatID) == "" || len(connection.out) != 0 {
		t.Fatal("late old feed callback affected active replacement grant")
	}
	current := rooms.joins[1]
	current.recipient.Enqueue(protocol.Event{Type: protocol.EventMessageSaved, Room: current.room, ChatID: current.chatID})
	if len(connection.out) != 1 {
		t.Fatal("new group feed did not accept authorized event")
	}
}

func TestSubscribeManyNewMembershipAndExistingGroupRenewTogether(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	member := map[string]bool{raceChatID: true}
	authorizer.onBatch = func(_ context.Context, _ int, ids []string) (map[string]bool, error) {
		allowed := make(map[string]bool, len(ids))
		for _, id := range ids {
			allowed[id] = member[id]
		}
		return allowed, nil
	}
	if err := connection.subscriptions.subscribeMany(pendingBatchItems()[:1]); err != nil {
		t.Fatal(err)
	}
	original := connection.subscriptions.groups[raceChatID]
	serial := connection.subscriptions.leases[raceChatID].serial
	member[secondRaceChatID] = true
	if err := connection.subscriptions.subscribeMany(pendingBatchItems()); err != nil {
		t.Fatal(err)
	}
	if authorizer.calls != 4 || authorizer.singleCalls != 0 || len(rooms.joins) != 2 || connection.subscriptions.groups[raceChatID] != original || connection.subscriptions.leases[raceChatID].serial == serial {
		t.Fatalf("mixed batch: calls=%d single=%d joins=%d", authorizer.calls, authorizer.singleCalls, len(rooms.joins))
	}
	if err := connection.subscriptions.subscribeMany(pendingBatchItems()); err != nil {
		t.Fatal(err)
	}
	if authorizer.calls != 5 || len(rooms.joins) != 2 {
		t.Fatal("renewal-only batch attached feeds or made a second RPC")
	}
}

func TestSubscribeManyRemovalWhileFinalCheckBlocked(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	checking, resume := make(chan struct{}), make(chan struct{})
	authorizer.onBatch = func(ctx context.Context, call int, ids []string) (map[string]bool, error) {
		if call == 2 {
			close(checking)
			select {
			case <-resume:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		return allowBatch(ids), nil
	}
	done := make(chan error, 1)
	go func() { done <- connection.subscriptions.subscribeMany(pendingBatchItems()) }()
	select {
	case <-checking:
	case <-time.After(time.Second):
		t.Fatal("final check did not start")
	}
	rooms.joins[0].recipient.Enqueue(protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.Group(raceChatID), ChatID: raceChatID, MemberID: raceChatID})
	close(resume)
	select {
	case err := <-done:
		if !errors.Is(err, grpcauth.ErrUnauthorized) {
			t.Fatalf("removed pending grant = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("batch did not stop")
	}
	assertNoPendingFeeds(t, connection, rooms)
}

func TestSubscribeManyFinalDenialRemovesExistingGroupAndNewFeeds(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	if err := connection.subscriptions.subscribeMany(pendingBatchItems()[:1]); err != nil {
		t.Fatal(err)
	}
	<-connection.out
	authorizer.onBatch = func(_ context.Context, call int, ids []string) (map[string]bool, error) {
		allowed := allowBatch(ids)
		if call == 4 {
			allowed[raceChatID] = false
		}
		return allowed, nil
	}
	if err := connection.subscriptions.subscribeMany(pendingBatchItems()); !errors.Is(err, grpcauth.ErrUnauthorized) {
		t.Fatalf("denied existing group = %v", err)
	}
	assertNoPendingFeeds(t, connection, rooms)
}

func TestSubscribeManyCancellationWhileFeedAttachBlockedCleansOwnedFeeds(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	base, cancel := context.WithCancel(connection.ctx)
	defer cancel()
	attaching := make(chan struct{})
	rooms.onJoin = func(ctx context.Context, join pendingJoin) error {
		if join.chatID == secondRaceChatID {
			close(attaching)
			<-ctx.Done()
			return ctx.Err()
		}
		return nil
	}
	done := make(chan error, 1)
	go func() {
		done <- connection.subscriptions.subscribeContext(base, pendingBatchItems(), batchSubscription)
	}()
	select {
	case <-attaching:
	case <-time.After(time.Second):
		t.Fatal("feed attach did not start")
	}
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("canceled batch = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("cancellation did not stop feed attach")
	}
	if authorizer.calls != 1 {
		t.Fatalf("canceled batch performed %d authorization calls", authorizer.calls)
	}
	assertNoPendingFeeds(t, connection, rooms)
}

func TestSubscribeManySessionRevocationWhileFinalCheckBlockedClosesFeeds(t *testing.T) {
	rooms := &pendingBatchRooms{}
	authorizer := &pendingBatchAuthorizer{}
	connection := newPendingBatchConnection(t, rooms, authorizer)
	checking := make(chan struct{})
	authorizer.onBatch = func(ctx context.Context, call int, ids []string) (map[string]bool, error) {
		if call == 2 {
			close(checking)
			<-ctx.Done()
		}
		return allowBatch(ids), nil
	}
	done := make(chan error, 1)
	go func() { done <- connection.subscriptions.subscribeMany(pendingBatchItems()) }()
	select {
	case <-checking:
	case <-time.After(time.Second):
		t.Fatal("final check did not start")
	}
	connection.Enqueue(protocol.Event{Type: protocol.EventSessionRevoked, Room: roomname.User(raceChatID), SessionID: connection.session.SessionID})
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("revoked session batch = %v", err)
		}
	case <-time.After(time.Second):
		t.Fatal("session revocation did not stop final check")
	}
	assertNoPendingFeeds(t, connection, rooms)
}
