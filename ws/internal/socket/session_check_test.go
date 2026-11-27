package socket

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/ticket"
)

func newCheckedConnection(t *testing.T, server *Server, identity ticket.Identity, due time.Time) *Connection {
	t.Helper()
	connection := newConnection(server, nil, identity)
	t.Cleanup(connection.Close)
	server.mu.Lock()
	server.connections[connection] = struct{}{}
	connection.nextSessionCheck = due
	server.mu.Unlock()
	return connection
}

func TestSessionCheckExtendsActiveAndClosesRevokedSockets(t *testing.T) {
	now := time.Now()
	ticketExpiry := now.Add(time.Minute)
	sessionExpiry := now.Add(time.Hour)
	active, otherDevice, loggedOut := strings.Repeat("a", 64), strings.Repeat("b", 64), strings.Repeat("c", 64)
	var calls int
	server, _ := newSessionServer(t, &sessionRooms{}, sessionAuthorizerFunc(func(_ context.Context, id string) (grpcauth.Session, error) {
		calls++
		switch id {
		case active:
			return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: id, ExpiresAt: sessionExpiry}, nil
		case otherDevice:
			return grpcauth.Session{UserID: sessionTestUser, DeviceID: "other", SessionID: id, ExpiresAt: sessionExpiry}, nil
		}
		return grpcauth.Session{}, grpcauth.ErrUnauthorized
	}))
	identity := func(sessionID string) ticket.Identity {
		return ticket.Identity{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID, ExpiresAt: ticketExpiry}
	}
	firstTab := newCheckedConnection(t, server, identity(active), now)
	secondTab := newCheckedConnection(t, server, identity(active), now)
	notDue := newCheckedConnection(t, server, identity(loggedOut), now.Add(time.Minute))
	mismatched := newCheckedConnection(t, server, identity(otherDevice), now)
	revoked := newCheckedConnection(t, server, identity(loggedOut), now)

	server.runSessionChecks(server.dueSessionChecks(now), now)

	if calls != 3 {
		t.Fatalf("validated %d sessions, want each due session once", calls)
	}
	for _, connection := range []*Connection{firstTab, secondTab} {
		if connection.ctx.Err() != nil || !connection.authorizationDeadline().Equal(now.Add(sessionAuthorizationWindow)) {
			t.Fatalf("active socket: closed=%v deadline=%v", connection.ctx.Err() != nil, connection.authorizationDeadline())
		}
		if next := connection.nextSessionCheck.Sub(now); next < sessionCheckInterval*4/5 || next > sessionCheckInterval*6/5 {
			t.Fatalf("next session check in %v", next)
		}
	}
	if notDue.ctx.Err() != nil {
		t.Fatal("socket was checked before its session check was due")
	}
	for _, connection := range []*Connection{mismatched, revoked} {
		if connection.ctx.Err() == nil || connection.closeReason != "session_revoked" {
			t.Fatalf("revoked socket: closed=%v reason=%q", connection.ctx.Err() != nil, connection.closeReason)
		}
	}
}

func TestSessionCheckDeadlineStopsAtSessionExpiry(t *testing.T) {
	now := time.Now()
	sessionExpiry := now.Add(time.Minute)
	connection := newRaceConnection(t, &raceRooms{}, nil)
	connection.sessionValidated(grpcauth.Session{ExpiresAt: sessionExpiry}, now)
	if !connection.authorizationDeadline().Equal(sessionExpiry) {
		t.Fatalf("deadline = %v, want session expiry %v", connection.authorizationDeadline(), sessionExpiry)
	}
}

func TestSessionCheckKeepsSocketsWhenAPIFails(t *testing.T) {
	now := time.Now()
	ticketExpiry := now.Add(time.Minute)
	server, _ := newSessionServer(t, &sessionRooms{}, sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) {
		return grpcauth.Session{}, errors.New("api unavailable")
	}))
	connection := newCheckedConnection(t, server, ticket.Identity{UserID: sessionTestUser, DeviceID: "device", SessionID: strings.Repeat("a", 64), ExpiresAt: ticketExpiry}, now)

	server.runSessionChecks(server.dueSessionChecks(now), now)

	if connection.ctx.Err() != nil || !connection.authorizationDeadline().Equal(ticketExpiry) || !connection.nextSessionCheck.Equal(now.Add(sessionCheckRetry)) {
		t.Fatalf("failed check: closed=%v deadline=%v next=%v", connection.ctx.Err() != nil, connection.authorizationDeadline(), connection.nextSessionCheck)
	}
}

func TestSessionCheckBatchesAreBounded(t *testing.T) {
	now := time.Now()
	server, _ := newSessionServer(t, &sessionRooms{}, nil)
	for index := range sessionCheckBatchSize + 1 {
		newCheckedConnection(t, server, ticket.Identity{UserID: sessionTestUser, SessionID: strings.Repeat(string(rune('a'+index%26)), 63) + string(rune('0'+index/26))}, now)
	}
	batches := server.dueSessionChecks(now)
	if len(batches) != 2 || len(batches[0])+len(batches[1]) != sessionCheckBatchSize+1 || len(batches[0]) > sessionCheckBatchSize || len(batches[1]) > sessionCheckBatchSize {
		t.Fatalf("batches = %d", len(batches))
	}
}

func TestHandshakeAuthorizesSocketUntilNextSessionCheck(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	sessionExpiry := time.Now().Add(24 * time.Hour)
	server, secret := newSessionServer(t, &sessionRooms{}, sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) {
		return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID, ExpiresAt: sessionExpiry}, nil
	}))
	before := time.Now()
	dialSessionSocket(t, http.HandlerFunc(server.upgrade), testWSToken(secret, sessionID))
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		server.mu.Lock()
		for connection := range server.connections {
			authorized, next := connection.authorizationDeadline(), connection.nextSessionCheck
			server.mu.Unlock()
			if next.IsZero() {
				server.mu.Lock()
				break
			}
			if authorized.Before(before.Add(sessionAuthorizationWindow)) || authorized.After(time.Now().Add(sessionAuthorizationWindow)) || next.Before(before.Add(sessionCheckInterval*4/5)) {
				t.Fatalf("authorized until %v, next check %v", authorized, next)
			}
			return
		}
		server.mu.Unlock()
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("socket was not admitted")
}
