package socket

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/ticket"
)

type sidebarTestDependencies struct {
	serverTestDependencies
	sidebarMu sync.Mutex
	chats     []grpcauth.SidebarChat
	authErr   error
	limited   bool
	feeds     map[string]chan protocol.Event
	started   chan string
	stopped   chan string
}

func (d *sidebarTestDependencies) AuthorizeSidebar(context.Context, string, []string) ([]grpcauth.SidebarChat, error) {
	d.sidebarMu.Lock()
	defer d.sidebarMu.Unlock()
	return append([]grpcauth.SidebarChat(nil), d.chats...), d.authErr
}

func (d *sidebarTestDependencies) AllowPresenceWatch(context.Context, string) (bool, error) {
	d.sidebarMu.Lock()
	defer d.sidebarMu.Unlock()
	return !d.limited, nil
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
	t.Helper()
	s := newTestServer(t, config.Config{MaxGroupAuths: 8, MaxMemberships: 1000, MaxRooms: 100, QueueItems: 32, QueueBytes: 65536, APITimeout: time.Second, WriteTimeout: time.Second, PingInterval: time.Hour}, testDependencies(&sessionRooms{}))
	d := &sidebarTestDependencies{feeds: make(map[string]chan protocol.Event), started: make(chan string, 10), stopped: make(chan string, 10)}
	s.groupAuth = d
	s.watchLimiter = d
	s.sidebarActivity = d
	s.sidebar = newSidebarCoordinator(s)
	t.Cleanup(func() {
		s.sidebar.mu.Lock()
		s.sidebar.state = lifecycleClosed
		for c := range s.sidebar.watches {
			s.sidebar.removeLocked(c)
		}
		s.sidebar.mu.Unlock()
		s.sidebar.wg.Wait()
	})
	return s, d
}

func sidebarTestConnection(t *testing.T, s *Server) *Connection {
	t.Helper()
	c := newConnection(s, nil, ticket.Identity{UserID: sessionTestUser, SessionID: strings.Repeat("a", 64)})
	t.Cleanup(c.Close)
	return c
}

func sidebarID(i int) string { return fmt.Sprintf("%026d", i+1) }

func TestSidebarSharesGroupActivityFeeds(t *testing.T) {
	s, d := newSidebarTestServer(t)
	group, direct := sidebarID(1), sidebarID(3)
	d.chats = []grpcauth.SidebarChat{{ChatID: group, Group: true}, {ChatID: direct}}
	d.feeds[group] = make(chan protocol.Event, 1)
	first, second := sidebarTestConnection(t, s), sidebarTestConnection(t, s)
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

func TestSidebarExpiryDenialAndRateLimit(t *testing.T) {
	s, d := newSidebarTestServer(t)
	group := sidebarID(1)
	d.chats = []grpcauth.SidebarChat{{ChatID: group, Group: true}}
	d.feeds[group] = make(chan protocol.Event)
	c := sidebarTestConnection(t, s)
	if err := c.watchSidebar(context.Background(), []string{group}); err != nil {
		t.Fatal(err)
	}
	s.sidebar.mu.Lock()
	watch := s.sidebar.watches[c]
	watch.nextAuth = time.Now().Add(-time.Second)
	s.sidebar.mu.Unlock()
	d.sidebarMu.Lock()
	d.authErr = grpcauth.ErrUnauthorized
	d.sidebarMu.Unlock()
	s.sidebar.sweep()
	s.sidebar.mu.Lock()
	removed := s.sidebar.watches[c] == nil
	s.sidebar.mu.Unlock()
	if !removed {
		t.Fatal("denied renewal kept the old grant")
	}
	d.sidebarMu.Lock()
	d.authErr, d.limited = nil, true
	d.sidebarMu.Unlock()
	if err := c.watchSidebar(context.Background(), []string{group}); !errors.Is(err, errRateLimited) {
		t.Fatalf("rate limit = %v", err)
	}
}
