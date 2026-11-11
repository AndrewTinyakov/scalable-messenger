package socket

import (
	"context"
	"sync"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
)

type sidebarTestDependencies struct {
	presenceTestDependencies
	sidebarMu sync.Mutex
	chats     []grpcauth.SidebarChat
	calls     int
	feeds     map[string]chan protocol.Event
	started   chan string
	stopped   chan string
	authorize func(context.Context, string, []string) ([]grpcauth.SidebarChat, error)
}

func (d *sidebarTestDependencies) AuthorizeSidebar(ctx context.Context, session string, ids []string) ([]grpcauth.SidebarChat, error) {
	d.sidebarMu.Lock()
	d.calls++
	action := d.authorize
	chats := append([]grpcauth.SidebarChat(nil), d.chats...)
	d.sidebarMu.Unlock()
	if action != nil {
		return action(ctx, session, ids)
	}
	return chats, nil
}
func (d *sidebarTestDependencies) RunActivity(ctx context.Context, id string, consume func(protocol.Event)) error {
	d.sidebarMu.Lock()
	events := d.feeds[id]
	d.sidebarMu.Unlock()
	d.started <- id
	defer func() { d.stopped <- id }()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case event := <-events:
			consume(event)
		}
	}
}
func newSidebarTestServer(t *testing.T) (*Server, *sidebarTestDependencies) {
	s, _ := newPresenceTestServer(t, 1000)
	s.config.MaxRooms = 100
	d := &sidebarTestDependencies{feeds: make(map[string]chan protocol.Event), started: make(chan string, 10), stopped: make(chan string, 10)}
	d.values = map[string]bool{}
	s.connectionLeases = d
	s.groupAuth = d
	s.handshakeLimiter = d
	s.presence = newPresenceCoordinator(s)
	s.sidebar = newSidebarCoordinator(s)
	t.Cleanup(func() {
		s.sidebar.mu.Lock()
		s.sidebar.closed = true
		for c := range s.sidebar.watches {
			s.sidebar.removeLocked(c)
		}
		s.sidebar.mu.Unlock()
		s.sidebar.wg.Wait()
	})
	return s, d
}
func TestSidebarSharesActivityFeedsAndKeepsSelectedPresence(t *testing.T) {
	s, d := newSidebarTestServer(t)
	group, peer, direct := presencePeer(1), presencePeer(2), presencePeer(3)
	d.chats = []grpcauth.SidebarChat{{ChatID: group, Group: true}, {ChatID: direct, PeerID: peer}}
	d.feeds[group] = make(chan protocol.Event, 1)
	first, second := presenceTestConnection(t, s), presenceTestConnection(t, s)
	d.allowed = []string{peer}
	if err := first.watchPresence(context.Background(), protocol.Frame{ChatID: direct, UserIDs: []string{peer}}); err != nil {
		t.Fatal(err)
	}
	for _, c := range []*Connection{first, second} {
		if err := c.watchSidebar(context.Background(), []string{group, direct}); err != nil {
			t.Fatal(err)
		}
	}
	select {
	case <-d.started:
	case <-time.After(time.Second):
		t.Fatal("activity feed did not start")
	}
	s.sidebar.mu.Lock()
	if len(s.sidebar.feeds) != 1 || len(s.sidebar.feeds[group].watchers) != 2 {
		t.Fatal("feeds were not shared")
	}
	old := s.sidebar.watches[first]
	s.sidebar.mu.Unlock()
	s.presence.mu.Lock()
	if s.presence.watches[first] == nil {
		t.Fatal("sidebar replaced selected presence")
	}
	s.presence.mu.Unlock()
	d.feeds[group] <- protocol.Event{Type: protocol.EventSidebarActivity, Version: 1, ChatID: group, Sequence: "9"}
	for _, c := range []*Connection{first, second} {
		select {
		case frame := <-c.out:
			if frame.frame.Event().Sequence != "9" || frame.frame.Event().Body != "" || frame.sidebarWatch == nil {
				t.Fatal("unexpected activity frame")
			}
		case <-time.After(time.Second):
			t.Fatal("missing activity")
		}
	}
	if err := first.watchSidebar(context.Background(), []string{}); err != nil {
		t.Fatal(err)
	}
	if s.sidebar.current(first, old) {
		t.Fatal("removed grant remained valid")
	}
	if err := second.watchSidebar(context.Background(), []string{}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-d.stopped:
	case <-time.After(time.Second):
		t.Fatal("feed was not joined on cancellation")
	}
}
func TestSidebarPresenceUnknownExpiryAndRateLimit(t *testing.T) {
	s, d := newSidebarTestServer(t)
	peer, direct := presencePeer(1), presencePeer(2)
	d.chats = []grpcauth.SidebarChat{{ChatID: direct, PeerID: peer}}
	c := presenceTestConnection(t, s)
	if err := c.watchSidebar(context.Background(), []string{direct}); err != nil {
		t.Fatal(err)
	}
	s.sidebar.sweep()
	select {
	case item := <-c.out:
		if len(item.frame.Event().Statuses) != 1 || item.frame.Event().Statuses[0].State != "unknown" {
			t.Fatal("unavailable presence was not unknown")
		}
	default:
		t.Fatal("missing presence snapshot")
	}
	s.sidebar.mu.Lock()
	watch := s.sidebar.watches[c]
	watch.expires = time.Now().Add(-time.Second)
	s.sidebar.mu.Unlock()
	if s.sidebar.current(c, watch) {
		t.Fatal("expired grant accepted")
	}
	s.sidebar.sweep()
	d.mu.Lock()
	d.limited = true
	d.mu.Unlock()
	if err := c.watchSidebar(context.Background(), []string{direct}); err != errRateLimited {
		t.Fatalf("rate limit = %v", err)
	}
}

func TestSidebarRenewsAuthorizationWhilePresenceIsPending(t *testing.T) {
	s, d := newSidebarTestServer(t)
	s.config.APITimeout = 5 * time.Second
	peer, direct := presencePeer(1), presencePeer(2)
	d.chats = []grpcauth.SidebarChat{{ChatID: direct, PeerID: peer}}
	c := presenceTestConnection(t, s)
	if err := c.watchSidebar(context.Background(), []string{direct}); err != nil {
		t.Fatal(err)
	}
	s.sidebar.mu.Lock()
	watch := s.sidebar.watches[c]
	watch.nextAuth = time.Time{}
	s.sidebar.mu.Unlock()
	presenceStarted := make(chan struct{})
	presenceReleased := make(chan struct{})
	var releaseOnce sync.Once
	releasePresence := func() { releaseOnce.Do(func() { close(presenceReleased) }) }
	authorizationStarted := make(chan struct{})
	d.source = func(ctx context.Context, _ []string) (map[string]bool, error) {
		close(presenceStarted)
		select {
		case <-presenceReleased:
			return map[string]bool{peer: true}, nil
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	d.authorize = func(context.Context, string, []string) ([]grpcauth.SidebarChat, error) {
		close(authorizationStarted)
		return []grpcauth.SidebarChat{{ChatID: direct, PeerID: peer}}, nil
	}
	done := make(chan struct{})
	go func() {
		s.sidebar.sweep()
		close(done)
	}()
	t.Cleanup(func() {
		releasePresence()
		select {
		case <-done:
		case <-time.After(time.Second):
			t.Error("sidebar sweep did not join its workers")
		}
	})
	select {
	case <-presenceStarted:
	case <-time.After(time.Second):
		t.Fatal("presence snapshot did not start")
	}
	select {
	case <-authorizationStarted:
	case <-time.After(time.Second):
		t.Fatal("presence snapshot blocked authorization renewal")
	}
	s.sidebar.mu.Lock()
	current := s.sidebar.watches[c]
	s.sidebar.mu.Unlock()
	if current != watch {
		t.Fatal("authorization was installed before the pending presence snapshot")
	}
	releasePresence()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("sidebar sweep did not complete")
	}
	select {
	case item := <-c.out:
		event := item.frame.Event()
		if item.sidebarWatch != watch || len(event.Statuses) != 1 || event.Statuses[0].State != "online" {
			t.Fatal("pending watch did not receive its presence snapshot before renewal")
		}
	default:
		t.Fatal("presence snapshot missing before renewal")
	}
	s.sidebar.mu.Lock()
	current = s.sidebar.watches[c]
	s.sidebar.mu.Unlock()
	if current == watch {
		t.Fatal("authorization renewal was not installed")
	}
}
