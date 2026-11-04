package socket

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
	"messenger/ws/internal/ticket"
)

type presenceTestDependencies struct {
	serverTestDependencies
	mu        sync.Mutex
	values    map[string]bool
	batches   [][]string
	sourceErr error
	source    func(context.Context, []string) (map[string]bool, error)
	allowed   []string
	authErr   error
	authorize func(context.Context, string, string, []string) ([]string, error)
	limited   bool
}

func (d *presenceTestDependencies) Presence(ctx context.Context, ids []string) (map[string]bool, error) {
	d.mu.Lock()
	d.batches = append(d.batches, append([]string(nil), ids...))
	values := make(map[string]bool, len(ids))
	for _, id := range ids {
		if online, ok := d.values[id]; ok {
			values[id] = online
		}
	}
	action, err := d.source, d.sourceErr
	d.mu.Unlock()
	if action != nil {
		return action(ctx, ids)
	}
	return values, err
}

func (d *presenceTestDependencies) AuthorizePresence(ctx context.Context, session, chat string, ids []string) ([]string, error) {
	d.mu.Lock()
	action := d.authorize
	allowed, err := append([]string(nil), d.allowed...), d.authErr
	d.mu.Unlock()
	if action != nil {
		return action(ctx, session, chat, ids)
	}
	return allowed, err
}

func (d *presenceTestDependencies) AllowPresenceWatch(context.Context, string) (bool, error) {
	d.mu.Lock()
	defer d.mu.Unlock()
	return !d.limited, nil
}

func newPresenceTestServer(t *testing.T, maxTargets int) (*Server, *presenceTestDependencies) {
	t.Helper()
	s := newTestServer(t, config.Config{MaxGroupAuths: 8, MaxMemberships: maxTargets, QueueItems: 32, QueueBytes: 65536, APITimeout: time.Second, WriteTimeout: time.Second, PingInterval: time.Hour}, testDependencies(&sessionRooms{}))
	d := &presenceTestDependencies{values: make(map[string]bool)}
	s.connectionLeases = d
	s.groupAuth = d
	s.handshakeLimiter = d
	s.presence = newPresenceCoordinator(s)
	if s.presence == nil {
		t.Fatal("presence interfaces did not enable coordinator")
	}
	return s, d
}

func presenceTestConnection(t *testing.T, s *Server) *Connection {
	t.Helper()
	c := newConnection(s, nil, ticket.Identity{UserID: sessionTestUser, SessionID: strings.Repeat("a", 64)}, "")
	t.Cleanup(c.Close)
	return c
}

func presencePeer(i int) string { return fmt.Sprintf("%026d", i+1) }

func presenceTestWatch(chat string, ids ...string) *presenceWatch {
	return &presenceWatch{chatID: chat, userIDs: ids, expires: time.Now().Add(presenceGrantTTL), nextAuth: time.Now().Add(20 * time.Second), states: make(map[string]string)}
}

func presenceForceSnapshot(p *presenceCoordinator) {
	p.mu.Lock()
	p.nextSnapshot = time.Time{}
	p.mu.Unlock()
	p.sweep()
}

func presenceTake(t *testing.T, c *Connection) outbound {
	t.Helper()
	select {
	case next := <-c.out:
		return next
	case <-time.After(time.Second):
		t.Fatal("presence snapshot did not arrive")
		return outbound{}
	}
}

func presenceStates(event protocol.Event) map[string]string {
	states := make(map[string]string, len(event.Statuses))
	for _, status := range event.Statuses {
		states[status.UserID] = status.State
	}
	return states
}

func TestPresenceNodeDeduplicatesTargetsAndBatchesAtOneHundred(t *testing.T) {
	s, d := newPresenceTestServer(t, 300)
	for device := range 3 {
		c := presenceTestConnection(t, s)
		ids := make([]string, 100)
		for i := range ids {
			ids[i] = presencePeer(device*75 + i)
			d.values[ids[i]] = true
		}
		if err := s.presence.install(c, presenceTestWatch(raceChatID, ids...)); err != nil {
			t.Fatal(err)
		}
	}
	presenceForceSnapshot(s.presence)
	seen := map[string]int{}
	d.mu.Lock()
	defer d.mu.Unlock()
	if len(d.batches) != 3 {
		t.Fatalf("snapshot calls = %d, want 3 for 250 distinct peers", len(d.batches))
	}
	for _, batch := range d.batches {
		if len(batch) == 0 || len(batch) > 100 {
			t.Fatalf("snapshot batch size = %d", len(batch))
		}
		for _, id := range batch {
			seen[id]++
		}
	}
	if len(seen) != 250 {
		t.Fatalf("queried distinct targets = %d, want 250", len(seen))
	}
	for id, count := range seen {
		if count != 1 {
			t.Fatalf("peer %s queried %d times", id, count)
		}
	}
}

func TestPresenceSnapshotsDiffsHeartbeatAndUnknown(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	a, b := presencePeer(0), presencePeer(1)
	d.values[a], d.values[b] = true, false
	watch := presenceTestWatch(raceChatID, a, b)
	if err := s.presence.install(c, watch); err != nil {
		t.Fatal(err)
	}
	presenceForceSnapshot(s.presence)
	first := presenceTake(t, c)
	event := first.frame.Event()
	if event.Type != protocol.EventPresence || event.ChatID != raceChatID || event.Version != 1 || event.ValidForMS <= 0 || event.ValidForMS > 30000 {
		t.Fatalf("snapshot metadata = %+v", event)
	}
	observed, err := time.Parse(time.RFC3339Nano, event.ObservedAt)
	if err != nil || time.Since(observed) < 0 || time.Since(observed) > time.Second {
		t.Fatalf("observation timestamp = %q, %v", event.ObservedAt, err)
	}
	if got := presenceStates(event); !reflect.DeepEqual(got, map[string]string{a: "online", b: "offline"}) {
		t.Fatalf("initial snapshot = %v", got)
	}
	d.values[b] = true
	presenceForceSnapshot(s.presence)
	if got := presenceStates(presenceTake(t, c).frame.Event()); !reflect.DeepEqual(got, map[string]string{b: "online"}) {
		t.Fatalf("presence diff = %v", got)
	}
	presenceForceSnapshot(s.presence)
	heartbeat := presenceTake(t, c).frame
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(heartbeat.Payload(), &wire); err != nil {
		t.Fatal(err)
	}
	if string(wire["statuses"]) != "[]" || heartbeat.Event().ObservedAt == event.ObservedAt {
		t.Fatalf("empty heartbeat = %s", heartbeat.Payload())
	}
	d.sourceErr = errors.New("Redis unavailable")
	presenceForceSnapshot(s.presence)
	if got := presenceStates(presenceTake(t, c).frame.Event()); !reflect.DeepEqual(got, map[string]string{a: "unknown", b: "unknown"}) {
		t.Fatalf("failed observation = %v", got)
	}
	d.sourceErr = nil
	delete(d.values, b)
	presenceForceSnapshot(s.presence)
	if got := presenceStates(presenceTake(t, c).frame.Event()); !reflect.DeepEqual(got, map[string]string{a: "online"}) {
		t.Fatalf("partial recovery diff = %v", got)
	}
}

func TestPresenceCapacityCountsUniquePeersAndReleasesReplacement(t *testing.T) {
	s, _ := newPresenceTestServer(t, 2)
	first, second := presenceTestConnection(t, s), presenceTestConnection(t, s)
	a, b, c := presencePeer(0), presencePeer(1), presencePeer(2)
	old := presenceTestWatch(raceChatID, a, b)
	if err := s.presence.install(first, old); err != nil {
		t.Fatal(err)
	}
	if err := s.presence.install(second, presenceTestWatch(raceChatID, b)); err != nil {
		t.Fatal(err)
	}
	if err := s.presence.install(second, presenceTestWatch(raceChatID, c)); !errors.Is(err, errRoomLimit) {
		t.Fatalf("third unique peer = %v", err)
	}
	if !s.presence.current(first, old) || s.presence.targets[b] != 2 {
		t.Fatal("failed watch changed existing grants")
	}
	replacement := presenceTestWatch(secondRaceChatID, c)
	if err := s.presence.install(first, replacement); err != nil {
		t.Fatalf("replacement failed after freeing old exclusive peer: %v", err)
	}
	if s.presence.current(first, old) || !s.presence.current(first, replacement) || len(s.presence.targets) != 2 || s.presence.targets[b] != 1 || s.presence.targets[c] != 1 {
		t.Fatalf("replacement targets = %v", s.presence.targets)
	}
	first.clearPresence()
	second.Close()
	if len(s.presence.targets) != 0 || len(s.presence.watches) != 0 {
		t.Fatal("unwatch and close retained node targets")
	}
	if err := s.presence.install(second, presenceTestWatch(raceChatID, a)); !errors.Is(err, context.Canceled) {
		t.Fatalf("watch on closed connection = %v", err)
	}
}

func TestPresenceAuthorizationRejectsForeignAndDuplicatePeers(t *testing.T) {
	for _, allowed := range [][]string{{presencePeer(1)}, {presencePeer(0), presencePeer(0)}} {
		t.Run(strings.Join(allowed, ","), func(t *testing.T) {
			s, d := newPresenceTestServer(t, 10)
			c := presenceTestConnection(t, s)
			d.allowed = allowed
			if err := c.watchPresence(c.ctx, protocol.Frame{ChatID: raceChatID, UserIDs: []string{presencePeer(0)}}); err == nil {
				t.Fatal("invalid authorization response installed a watch")
			}
			if len(s.presence.targets) != 0 {
				t.Fatal("invalid authorization response retained targets")
			}
		})
	}
}

func TestPresenceWatchUsesAuthorizedSubsetAndRateLimit(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	a, b := presencePeer(0), presencePeer(1)
	d.authorize = func(_ context.Context, session, chat string, ids []string) ([]string, error) {
		if session != c.session.SessionID || chat != raceChatID || !reflect.DeepEqual(ids, []string{a, b}) {
			return nil, errors.New("wrong authorization scope")
		}
		return []string{b}, nil
	}
	frame := protocol.Frame{Type: protocol.FrameWatchPresence, ChatID: raceChatID, UserIDs: []string{a, b}}
	if err := c.watchPresence(c.ctx, frame); err != nil {
		t.Fatal(err)
	}
	watch := s.presence.watches[c]
	if !reflect.DeepEqual(watch.userIDs, []string{b}) || watch.expires.After(time.Now().Add(presenceGrantTTL)) {
		t.Fatalf("authorized watch = %+v", watch)
	}
	d.limited = true
	if err := c.watchPresence(c.ctx, frame); !errors.Is(err, errRateLimited) {
		t.Fatalf("limited watch = %v", err)
	}
	if !s.presence.current(c, watch) {
		t.Fatal("rate-limited attempt invalidated existing watch")
	}
	d.limited = false
	d.authorize = nil
	d.authErr = grpcauth.ErrUnauthorized
	if err := c.watchPresence(c.ctx, frame); !errors.Is(err, grpcauth.ErrUnauthorized) {
		t.Fatalf("denied replacement = %v", err)
	}
	if len(s.presence.watches) != 0 || len(s.presence.targets) != 0 {
		t.Fatal("denied authorization retained old watch")
	}
}

func TestPresenceRevalidationDropsRemovedPeersAndFailedGrants(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	a, b := presencePeer(0), presencePeer(1)
	watch := presenceTestWatch(raceChatID, a, b)
	watch.nextAuth = time.Now().Add(-time.Second)
	if err := s.presence.install(c, watch); err != nil {
		t.Fatal(err)
	}
	d.allowed = []string{b}
	s.presence.renewGrants(time.Now())
	renewed := s.presence.watches[c]
	if renewed == nil || !reflect.DeepEqual(renewed.userIDs, []string{b}) || len(s.presence.targets) != 1 || s.presence.targets[b] != 1 {
		t.Fatalf("membership revalidation = %+v, targets=%v", renewed, s.presence.targets)
	}
	if s.presence.current(c, watch) {
		t.Fatal("revalidation retained old snapshot authorization")
	}
	watch = renewed
	watch.nextAuth = time.Now().Add(-time.Second)
	d.authErr = errors.New("authorization unavailable")
	s.presence.renewGrants(time.Now())
	if s.presence.current(c, watch) || len(s.presence.targets) != 0 {
		t.Fatal("failed authorization retained presence grant")
	}
}

func TestPresenceExpiredGrantCannotDeliverAndIsRemoved(t *testing.T) {
	s, _ := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	watch := presenceTestWatch(raceChatID, presencePeer(0))
	watch.expires = time.Now().Add(-time.Second)
	if err := s.presence.install(c, watch); err != nil {
		t.Fatal(err)
	}
	if s.presence.current(c, watch) {
		t.Fatal("expired grant remained current")
	}
	presenceForceSnapshot(s.presence)
	if len(c.out) != 0 || len(s.presence.watches) != 0 || len(s.presence.targets) != 0 {
		t.Fatal("expired grant delivered a snapshot or retained targets")
	}
}

func TestPresenceMembershipRemovalAndChatDeletionClearOnlyTheirWatch(t *testing.T) {
	for _, eventType := range []protocol.EventType{protocol.EventMemberRemoved, protocol.EventChatDeleted} {
		t.Run(string(eventType), func(t *testing.T) {
			s, _ := newPresenceTestServer(t, 10)
			c := presenceTestConnection(t, s)
			watch := presenceTestWatch(raceChatID, presencePeer(0))
			if err := s.presence.install(c, watch); err != nil {
				t.Fatal(err)
			}
			event := protocol.Event{Type: eventType, ChatID: secondRaceChatID, Room: roomname.User(c.session.UserID), MemberID: c.session.UserID}
			c.Enqueue(event)
			if !s.presence.current(c, watch) {
				t.Fatal("unrelated chat event cleared watch")
			}
			event.ChatID = raceChatID
			c.Enqueue(event)
			if s.presence.current(c, watch) || len(s.presence.targets) != 0 {
				t.Fatal("terminal membership event retained watch")
			}
		})
	}
}

func TestPresenceWriterDiscardsOldWatchBeforeSendingReplacement(t *testing.T) {
	s, _ := newPresenceTestServer(t, 10)
	c, client := presenceSocket(t, s)
	old := presenceTestWatch(raceChatID, presencePeer(0))
	if err := s.presence.install(c, old); err != nil {
		t.Fatal(err)
	}
	frame, _ := protocol.NewEventFrame(protocol.Event{Type: protocol.EventPresence, ChatID: raceChatID, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Statuses: []protocol.PresenceStatus{{UserID: presencePeer(0), State: "online"}}})
	if !c.enqueueFrame(frame, nil, old) {
		t.Fatal("old snapshot not queued")
	}
	replacement := presenceTestWatch(secondRaceChatID, presencePeer(1))
	if err := s.presence.install(c, replacement); err != nil {
		t.Fatal(err)
	}
	frame, _ = protocol.NewEventFrame(protocol.Event{Type: protocol.EventPresence, ChatID: secondRaceChatID, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Statuses: []protocol.PresenceStatus{}})
	if !c.enqueueFrame(frame, nil, replacement) {
		t.Fatal("replacement heartbeat not queued")
	}
	presenceStartWriter(t, c)
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	_, payload, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var event protocol.Event
	if err := json.Unmarshal(payload, &event); err != nil || event.ChatID != secondRaceChatID {
		t.Fatalf("stale watch reached socket: %s, %v", payload, err)
	}
}

func TestPresenceAuthorizationCompletionCannotReinstallAfterClose(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	entered, release := make(chan struct{}), make(chan struct{})
	d.authorize = func(ctx context.Context, _ string, _ string, ids []string) ([]string, error) {
		close(entered)
		select {
		case <-release:
			return ids, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	done := make(chan error, 1)
	go func() {
		done <- c.watchPresence(c.ctx, protocol.Frame{ChatID: raceChatID, UserIDs: []string{presencePeer(0)}})
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("authorization did not start")
	}
	c.Close()
	close(release)
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("closed connection installed watch")
		}
	case <-time.After(time.Second):
		t.Fatal("authorization did not stop")
	}
	s.presence.mu.Lock()
	defer s.presence.mu.Unlock()
	if len(s.presence.watches) != 0 || len(s.presence.targets) != 0 {
		t.Fatal("closed connection retained presence targets")
	}
}

func TestPresenceWriterDiscardsSnapshotAfterAuthorizationSubsetShrinks(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c, client := presenceSocket(t, s)
	a, b := presencePeer(0), presencePeer(1)
	watch := presenceTestWatch(raceChatID, a, b)
	if err := s.presence.install(c, watch); err != nil {
		t.Fatal(err)
	}
	frame, _ := protocol.NewEventFrame(protocol.Event{Type: protocol.EventPresence, ChatID: raceChatID, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Statuses: []protocol.PresenceStatus{{UserID: a, State: "online"}, {UserID: b, State: "offline"}}})
	if !c.enqueueFrame(frame, nil, watch) {
		t.Fatal("old snapshot not queued")
	}
	d.allowed = []string{b}
	s.presence.renew(c.ctx, presenceRenewal{connection: c, watch: watch}, time.Now())
	current := s.presence.watches[c]
	if current == nil || !reflect.DeepEqual(current.userIDs, []string{b}) {
		t.Fatal("grant did not shrink")
	}
	frame, _ = protocol.NewEventFrame(protocol.Event{Type: protocol.EventPresence, ChatID: raceChatID, ObservedAt: time.Now().UTC().Format(time.RFC3339Nano), Statuses: []protocol.PresenceStatus{{UserID: b, State: "offline"}}})
	if !c.enqueueFrame(frame, nil, current) {
		t.Fatal("current snapshot not queued")
	}
	presenceStartWriter(t, c)
	_ = client.SetReadDeadline(time.Now().Add(time.Second))
	_, payload, err := client.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	var event protocol.Event
	if err := json.Unmarshal(payload, &event); err != nil {
		t.Fatal(err)
	}
	if got := presenceStates(event); !reflect.DeepEqual(got, map[string]string{b: "offline"}) {
		t.Fatalf("queued snapshot exposed revoked peer: %s", payload)
	}
}

func TestPresenceRevalidationCannotReinstallUnwatchedGrant(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	watch := presenceTestWatch(raceChatID, presencePeer(0))
	if err := s.presence.install(c, watch); err != nil {
		t.Fatal(err)
	}
	entered, release := make(chan struct{}), make(chan struct{})
	d.authorize = func(ctx context.Context, _ string, _ string, ids []string) ([]string, error) {
		close(entered)
		select {
		case <-release:
			return ids, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	done := make(chan struct{})
	go func() { s.presence.renew(c.ctx, presenceRenewal{connection: c, watch: watch}, time.Now()); close(done) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("renewal did not start")
	}
	c.clearPresence()
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("renewal did not stop")
	}
	if len(s.presence.watches) != 0 || len(s.presence.targets) != 0 {
		t.Fatal("late authorization restored unwatched targets")
	}
}

func TestPresenceRuntimeStopsOnServerShutdown(t *testing.T) {
	s, _ := newPresenceTestServer(t, 10)
	done := make(chan struct{})
	s.wg.Add(1)
	go func() { defer s.wg.Done(); s.presence.run(); close(done) }()
	s.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("presence runtime survived server shutdown")
	}
}

func TestPresenceSnapshotCancellationJoinsBoundedWorkers(t *testing.T) {
	s, d := newPresenceTestServer(t, 2000)
	var active, maximum atomic.Int32
	entered := make(chan struct{}, 1200)
	d.source = func(ctx context.Context, _ []string) (map[string]bool, error) {
		current := active.Add(1)
		defer active.Add(-1)
		for old := maximum.Load(); current > old; old = maximum.Load() {
			if maximum.CompareAndSwap(old, current) {
				break
			}
		}
		entered <- struct{}{}
		<-ctx.Done()
		return nil, ctx.Err()
	}
	peers := make([]string, 1200)
	for i := range peers {
		peers[i] = presencePeer(i)
	}
	ctx, cancel := context.WithCancel(s.ctx)
	defer cancel()
	done := make(chan struct{})
	go func() { s.presence.snapshot(ctx, peers); close(done) }()
	for range 8 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("snapshot workers did not start")
		}
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("snapshot did not join canceled workers")
	}
	if maximum.Load() > 8 || active.Load() != 0 {
		t.Fatalf("snapshot workers maximum=%d, still active=%d", maximum.Load(), active.Load())
	}
}

func TestPresenceRemovedPeerBecomesUnknownOnceAndIsNoLongerQueried(t *testing.T) {
	s, d := newPresenceTestServer(t, 10)
	c := presenceTestConnection(t, s)
	a, b := presencePeer(0), presencePeer(1)
	d.values[a], d.values[b] = true, false
	watch := presenceTestWatch(raceChatID, a, b)
	if err := s.presence.install(c, watch); err != nil {
		t.Fatal(err)
	}
	presenceForceSnapshot(s.presence)
	presenceTake(t, c)
	d.allowed = []string{b}
	s.presence.renew(c.ctx, presenceRenewal{connection: c, watch: watch}, time.Now())
	d.mu.Lock()
	d.batches = nil
	d.mu.Unlock()
	presenceForceSnapshot(s.presence)
	if got := presenceStates(presenceTake(t, c).frame.Event()); !reflect.DeepEqual(got, map[string]string{a: "unknown"}) {
		t.Fatalf("removed peer invalidation = %v", got)
	}
	presenceForceSnapshot(s.presence)
	if got := presenceStates(presenceTake(t, c).frame.Event()); len(got) != 0 {
		t.Fatalf("removed peer repeated in heartbeat = %v", got)
	}
	d.mu.Lock()
	defer d.mu.Unlock()
	for _, batch := range d.batches {
		if !reflect.DeepEqual(batch, []string{b}) {
			t.Fatalf("snapshot queried revoked target: %v", batch)
		}
	}
}

func presenceSocket(t *testing.T, s *Server) (*Connection, *websocket.Conn) {
	t.Helper()
	accepted := make(chan *websocket.Conn, 1)
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			accepted <- socket
		}
	}))
	t.Cleanup(httpServer.Close)
	client, _, err := websocket.DefaultDialer.Dial(strings.Replace(httpServer.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	var socket *websocket.Conn
	select {
	case socket = <-accepted:
	case <-time.After(time.Second):
		t.Fatal("socket not accepted")
	}
	c := newConnection(s, socket, ticket.Identity{UserID: sessionTestUser}, "")
	t.Cleanup(c.Close)
	return c, client
}

func presenceStartWriter(t *testing.T, c *Connection) {
	t.Helper()
	done := make(chan struct{})
	go func() { c.writeLoop(); close(done) }()
	t.Cleanup(func() {
		c.Close()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("writer did not stop")
		}
	})
}

func TestPresenceAuthorizationCompletionCannotRestoreRemovedChat(t *testing.T) {
	for _, eventType := range []protocol.EventType{protocol.EventMemberRemoved, protocol.EventChatDeleted} {
		t.Run(string(eventType), func(t *testing.T) {
			s, d := newPresenceTestServer(t, 10)
			c := presenceTestConnection(t, s)
			entered, release := make(chan struct{}), make(chan struct{})
			d.authorize = func(ctx context.Context, _ string, _ string, ids []string) ([]string, error) {
				close(entered)
				select {
				case <-release:
					return ids, nil
				case <-ctx.Done():
					return nil, ctx.Err()
				}
			}
			done := make(chan error, 1)
			go func() {
				done <- c.watchPresence(c.ctx, protocol.Frame{ChatID: raceChatID, UserIDs: []string{presencePeer(0)}})
			}()
			select {
			case <-entered:
			case <-time.After(time.Second):
				t.Fatal("authorization did not start")
			}
			c.Enqueue(protocol.Event{Type: eventType, ChatID: raceChatID, Room: roomname.User(c.session.UserID), MemberID: c.session.UserID})
			close(release)
			select {
			case err := <-done:
				if err == nil {
					t.Error("authorization completed after terminal chat event")
				}
			case <-time.After(time.Second):
				t.Fatal("authorization did not stop")
			}
			if len(s.presence.watches) != 0 || len(s.presence.targets) != 0 {
				t.Fatal("late authorization restored removed chat presence")
			}
		})
	}
}

type presenceEstablishLeases struct {
	*trackingConnectionLeases
	established      bool
	err              error
	promoted         atomic.Int32
	sessionValidated *atomic.Bool
}

func (leases *presenceEstablishLeases) EstablishConnectionLease(_ context.Context, user, lease string) (bool, error) {
	leases.promoted.Add(1)
	if !leases.sessionValidated.Load() || user != sessionTestUser || lease != "test-lease" {
		return false, errors.New("presence promoted before session validation or with wrong lease")
	}
	return leases.established, leases.err
}

func TestPresenceFailedPromotionClosesSocketAndReleasesReservation(t *testing.T) {
	for _, test := range []struct {
		name           string
		sessionAllowed bool
		promoteErr     error
	}{
		{name: "expired reservation", sessionAllowed: true},
		{name: "Redis unavailable", sessionAllowed: true, promoteErr: errors.New("Redis unavailable")},
		{name: "session revoked before promotion", sessionAllowed: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			sessionID := strings.Repeat("a", 64)
			var validated atomic.Bool
			server, secret := newSessionServer(t, &sessionRooms{}, func(context.Context, string) (grpcauth.Session, error) {
				if !test.sessionAllowed {
					return grpcauth.Session{}, grpcauth.ErrUnauthorized
				}
				validated.Store(true)
				return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID}, nil
			})
			leases := &presenceEstablishLeases{trackingConnectionLeases: &trackingConnectionLeases{release: make(chan struct{}, 1)}, sessionValidated: &validated, err: test.promoteErr}
			server.connectionLeases = leases
			done := make(chan struct{})
			socket := dialSessionSocket(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { server.upgrade(w, r); close(done) }), testWSToken(secret, sessionID))
			_ = socket.SetReadDeadline(time.Now().Add(time.Second))
			if _, _, err := socket.ReadMessage(); err == nil {
				t.Fatal("failed promotion left socket open")
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("failed promotion did not stop handshake")
			}
			select {
			case <-leases.release:
			case <-time.After(time.Second):
				t.Fatal("failed promotion retained connection reservation")
			}
			acquired, released := leases.counts()
			if acquired != 1 || released != 1 {
				t.Fatalf("leases acquired=%d released=%d", acquired, released)
			}
			wantPromoted := int32(0)
			if test.sessionAllowed {
				wantPromoted = 1
			}
			if leases.promoted.Load() != wantPromoted {
				t.Fatalf("promotion attempts=%d, want %d", leases.promoted.Load(), wantPromoted)
			}
		})
	}
}
