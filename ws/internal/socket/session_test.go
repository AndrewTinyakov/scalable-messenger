package socket

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/ticket"
)

const sessionTestUser = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

type sessionAuthorizerFunc func(context.Context, string) (grpcauth.Session, error)

func (fn sessionAuthorizerFunc) ValidateSession(ctx context.Context, token string) (grpcauth.Session, error) {
	return fn(ctx, token)
}

type handshakeLimiterFunc func(context.Context, string, int, time.Duration) (bool, error)

func (fn handshakeLimiterFunc) AllowHandshake(ctx context.Context, userID string, limit int, window time.Duration) (bool, error) {
	return fn(ctx, userID, limit, window)
}

type sessionRooms struct {
	join    func(roomregistry.Recipient)
	onClose func()
	closed  sync.Once
}

type trackingConnectionLeases struct {
	mu       sync.Mutex
	acquired int
	released int
	release  chan struct{}
}

func (leases *trackingConnectionLeases) AcquireConnectionLease(context.Context, string) (string, bool, error) {
	leases.mu.Lock()
	leases.acquired++
	leases.mu.Unlock()
	return "test-lease", true, nil
}

func (*trackingConnectionLeases) RenewConnectionLease(context.Context, string, string) (bool, error) {
	return true, nil
}

func (leases *trackingConnectionLeases) ReleaseConnectionLease(_ context.Context, _, _ string) error {
	leases.mu.Lock()
	leases.released++
	leases.mu.Unlock()
	leases.release <- struct{}{}
	return nil
}

func (leases *trackingConnectionLeases) counts() (int, int) {
	leases.mu.Lock()
	defer leases.mu.Unlock()
	return leases.acquired, leases.released
}

func (rooms *sessionRooms) Join(_ context.Context, recipient roomregistry.Recipient, _, _, _, _ string) error {
	if rooms.join != nil {
		rooms.join(recipient)
	}
	return nil
}
func (*sessionRooms) LeaveAll(roomregistry.Recipient)                  {}
func (*sessionRooms) LeaveChat(roomregistry.Recipient, string, string) {}
func (*sessionRooms) RunChecks(context.Context)                        {}
func (rooms *sessionRooms) Close() {
	rooms.closed.Do(func() {
		if rooms.onClose != nil {
			rooms.onClose()
		}
	})
}

type blockingAcquireLeases struct {
	entered chan struct{}
	release chan struct{}
}

func (leases *blockingAcquireLeases) AcquireConnectionLease(context.Context, string) (string, bool, error) {
	close(leases.entered)
	<-leases.release
	return "test-lease", true, nil
}
func (*blockingAcquireLeases) RenewConnectionLease(context.Context, string, string) (bool, error) {
	return true, nil
}
func (*blockingAcquireLeases) ReleaseConnectionLease(context.Context, string, string) error {
	return nil
}

type blockingReleaseLeases struct {
	entered chan struct{}
	release chan struct{}
	mu      sync.Mutex
	active  int
	maximum int
}

func (*blockingReleaseLeases) AcquireConnectionLease(context.Context, string) (string, bool, error) {
	return "test-lease", true, nil
}
func (*blockingReleaseLeases) RenewConnectionLease(context.Context, string, string) (bool, error) {
	return true, nil
}
func (leases *blockingReleaseLeases) ReleaseConnectionLease(ctx context.Context, _, _ string) error {
	leases.mu.Lock()
	leases.active++
	if leases.active > leases.maximum {
		leases.maximum = leases.active
	}
	leases.mu.Unlock()
	leases.entered <- struct{}{}
	select {
	case <-leases.release:
	case <-ctx.Done():
	}
	leases.mu.Lock()
	leases.active--
	leases.mu.Unlock()
	return nil
}

func testWSToken(secret, sessionID string) string {
	header := base64.RawURLEncoding.EncodeToString([]byte(`{"alg":"HS256","typ":"JWT"}`))
	claims := `{"iss":"messenger-api","aud":"messenger-ws","sub":"` + sessionTestUser + `","deviceId":"device","sid":"` + sessionID + `","exp":` + "2000000000" + `}`
	data := header + "." + base64.RawURLEncoding.EncodeToString([]byte(claims))
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(data))
	return data + "." + base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

func newSessionServer(t *testing.T, rooms *sessionRooms, auth sessionAuthorizerFunc) (*Server, string) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	secret := "test-ws-ticket-secret-long-enough-for-hmac-2026"
	server := &Server{
		config: config.Config{WSTicketSecret: secret, AllowedOrigin: "*", MaxConnections: 10, HandshakeRate: 30, HandshakeWindow: time.Minute, QueueItems: 8, QueueBytes: 4096, PendingACKLimit: 8, ACKTimeout: time.Second, APITimeout: time.Second, WriteTimeout: time.Second, PingInterval: time.Second, PongTimeout: time.Minute, GroupLease: time.Minute},
		logger: slog.New(slog.NewTextHandler(io.Discard, nil)), sessionAuth: auth, rooms: rooms,
		metrics: monitoring.New(prometheus.NewRegistry()), ctx: ctx, cancel: cancel, connections: make(map[*Connection]struct{}),
	}
	t.Cleanup(server.Close)
	return server, secret
}

func dialSessionSocket(t *testing.T, handler http.Handler, token string) *websocket.Conn {
	t.Helper()
	httpServer := httptest.NewServer(handler)
	t.Cleanup(httpServer.Close)
	dialer := websocket.Dialer{Subprotocols: []string{"messenger", "messenger-ticket." + token}}
	socket, response, err := dialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws", nil)
	if err != nil {
		t.Fatalf("dial WS: %v (response: %v)", err, response)
	}
	t.Cleanup(func() { _ = socket.Close() })
	return socket
}

func TestSessionRevocationOnlyClosesMatchingSocket(t *testing.T) {
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(context.Context, string, string) (string, error) { return "", nil }))
	connection.session = ticket.Identity{UserID: sessionTestUser, SessionID: strings.Repeat("a", 64)}
	if !connection.Enqueue(protocol.Event{Type: "session_revoked", Room: "user:" + sessionTestUser, SessionID: strings.Repeat("b", 64)}) {
		t.Fatal("nonmatching revocation was rejected")
	}
	if connection.ctx.Err() != nil || len(connection.out) != 0 {
		t.Fatal("nonmatching revocation closed socket or reached browser")
	}
	connection.Enqueue(protocol.Event{Type: "session_revoked", Room: "user:" + sessionTestUser, SessionID: connection.session.SessionID})
	if connection.ctx.Err() == nil || len(connection.out) != 0 {
		t.Fatal("matching revocation did not close socket, or reached browser")
	}
}

func TestRevokedSessionIsRejectedAfterUserRoomJoin(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	joined := false
	rooms := &sessionRooms{join: func(roomregistry.Recipient) { joined = true }}
	auth := sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) {
		if !joined {
			t.Error("validated session before joining the user room")
		}
		return grpcauth.Session{}, grpcauth.ErrUnauthorized
	})
	server, secret := newSessionServer(t, rooms, auth)
	socket := dialSessionSocket(t, http.HandlerFunc(server.upgrade), testWSToken(secret, sessionID))
	_ = socket.SetReadDeadline(time.Now().Add(time.Second))
	_, _, err := socket.ReadMessage()
	var closeErr *websocket.CloseError
	if !errors.As(err, &closeErr) || closeErr.Code != 4003 {
		t.Fatalf("read after revoked session = %v, want close 4003", err)
	}
}

func TestUserRoomEventsWaitForSessionValidation(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	joined := make(chan *Connection, 1)
	validated := make(chan struct{})
	release := make(chan struct{})
	rooms := &sessionRooms{join: func(recipient roomregistry.Recipient) {
		connection := recipient.(*Connection)
		connection.Enqueue(protocol.Event{Type: "chat_created", Version: 1, ChatID: sessionTestUser})
		joined <- connection
	}}
	auth := sessionAuthorizerFunc(func(ctx context.Context, _ string) (grpcauth.Session, error) {
		close(validated)
		select {
		case <-release:
			return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID}, nil
		case <-ctx.Done():
			return grpcauth.Session{}, ctx.Err()
		}
	})
	server, secret := newSessionServer(t, rooms, auth)
	socket := dialSessionSocket(t, http.HandlerFunc(server.upgrade), testWSToken(secret, sessionID))
	select {
	case <-validated:
	case <-time.After(time.Second):
		t.Fatal("session validation was not called")
	}
	connection := <-joined
	if got := len(connection.out); got != 1 {
		t.Fatalf("queued user-room events before session validation = %d, want 1", got)
	}
	close(release)
	_ = socket.SetReadDeadline(time.Now().Add(time.Second))
	_, data, err := socket.ReadMessage()
	if err != nil || !strings.Contains(string(data), `"type":"chat_created"`) {
		t.Fatalf("read after validation = %q, %v", data, err)
	}
}

func TestDeniedSessionReleasesConnectionLease(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	auth := sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) {
		return grpcauth.Session{}, grpcauth.ErrUnauthorized
	})
	server, secret := newSessionServer(t, &sessionRooms{}, auth)
	leases := &trackingConnectionLeases{release: make(chan struct{}, 1)}
	server.connectionLeases = leases
	done := make(chan struct{})
	socket := dialSessionSocket(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.upgrade(w, r)
		close(done)
	}), testWSToken(secret, sessionID))
	_ = socket.SetReadDeadline(time.Now().Add(time.Second))
	_, _, _ = socket.ReadMessage()
	select {
	case <-leases.release:
	case <-time.After(time.Second):
		t.Fatal("denied session did not release its connection lease")
	}
	<-done
	if acquired, released := leases.counts(); acquired != 1 || released != 1 || server.pendingUpgrades != 0 {
		t.Fatalf("denied session: acquired=%d released=%d pending=%d", acquired, released, server.pendingUpgrades)
	}
}

func TestFailedHTTPUpgradeReleasesConnectionLease(t *testing.T) {
	server, secret := newSessionServer(t, &sessionRooms{}, nil)
	leases := &trackingConnectionLeases{release: make(chan struct{}, 1)}
	server.connectionLeases = leases
	done := make(chan struct{})
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.upgrade(w, r)
		close(done)
	}))
	defer httpServer.Close()
	request, err := http.NewRequest(http.MethodGet, httpServer.URL+"/ws", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Sec-WebSocket-Protocol", "messenger, messenger-ticket."+testWSToken(secret, strings.Repeat("a", 64)))
	response, err := http.DefaultClient.Do(request)
	if err != nil || response.StatusCode != http.StatusBadRequest {
		t.Fatalf("malformed upgrade: error=%v response=%v, want HTTP 400", err, response)
	}
	defer response.Body.Close()
	select {
	case <-leases.release:
	case <-time.After(time.Second):
		t.Fatal("failed HTTP upgrade did not release its connection lease")
	}
	<-done
	if acquired, released := leases.counts(); acquired != 1 || released != 1 || server.pendingUpgrades != 0 {
		t.Fatalf("failed HTTP upgrade: acquired=%d released=%d pending=%d", acquired, released, server.pendingUpgrades)
	}
}

func TestInvalidOriginDoesNotAcquireConnectionLease(t *testing.T) {
	server, secret := newSessionServer(t, &sessionRooms{}, nil)
	server.config.AllowedOrigin = "https://allowed.example"
	leases := &trackingConnectionLeases{release: make(chan struct{}, 1)}
	server.connectionLeases = leases
	httpServer := httptest.NewServer(http.HandlerFunc(server.upgrade))
	defer httpServer.Close()
	dialer := websocket.Dialer{Subprotocols: []string{"messenger", "messenger-ticket." + testWSToken(secret, strings.Repeat("a", 64))}}
	header := http.Header{"Origin": []string{"https://other.example"}}
	_, response, err := dialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws", header)
	if err == nil || response == nil || response.StatusCode != http.StatusForbidden {
		t.Fatalf("invalid origin: error=%v response=%v, want HTTP 403", err, response)
	}
	if acquired, released := leases.counts(); acquired != 0 || released != 0 {
		t.Fatalf("invalid origin: acquired=%d released=%d, want no Redis admission work", acquired, released)
	}
}

func TestHandshakeLimitRejectsBeforeConnectionLease(t *testing.T) {
	server, secret := newSessionServer(t, &sessionRooms{}, nil)
	leases := &trackingConnectionLeases{release: make(chan struct{}, 1)}
	server.connectionLeases = leases
	called := false
	server.handshakeLimiter = handshakeLimiterFunc(func(_ context.Context, userID string, limit int, window time.Duration) (bool, error) {
		called = true
		if userID != sessionTestUser || limit != 30 || window != time.Minute {
			t.Errorf("handshake limit args = %q, %d, %s", userID, limit, window)
		}
		return false, nil
	})
	done := make(chan struct{})
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.upgrade(w, r)
		close(done)
	}))
	defer httpServer.Close()
	dialer := websocket.Dialer{Subprotocols: []string{"messenger", "messenger-ticket." + testWSToken(secret, strings.Repeat("a", 64))}}
	_, response, err := dialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws", nil)
	if err == nil || response == nil || response.StatusCode != http.StatusTooManyRequests {
		t.Fatalf("limited handshake: error=%v response=%v, want HTTP 429", err, response)
	}
	<-done
	if !called {
		t.Fatal("handshake limiter was not called")
	}
	if acquired, released := leases.counts(); acquired != 0 || released != 0 || server.pendingUpgrades != 0 {
		t.Fatalf("limited handshake: acquired=%d released=%d pending=%d", acquired, released, server.pendingUpgrades)
	}
}

func TestClosedSocketReleasesConnectionLease(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	auth := sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) {
		return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID}, nil
	})
	server, secret := newSessionServer(t, &sessionRooms{}, auth)
	leases := &trackingConnectionLeases{release: make(chan struct{}, 1)}
	server.connectionLeases = leases
	socket := dialSessionSocket(t, http.HandlerFunc(server.upgrade), testWSToken(secret, sessionID))
	if err := socket.Close(); err != nil {
		t.Fatalf("close socket: %v", err)
	}
	select {
	case <-leases.release:
	case <-time.After(time.Second):
		t.Fatal("closed socket did not release its connection lease")
	}
	if acquired, released := leases.counts(); acquired != 1 || released != 1 {
		t.Fatalf("closed socket: acquired=%d released=%d", acquired, released)
	}
}

func TestShutdownWaitsForInFlightUpgrade(t *testing.T) {
	roomsClosed := make(chan struct{})
	rooms := &sessionRooms{onClose: func() { close(roomsClosed) }}
	server, secret := newSessionServer(t, rooms, nil)
	leases := &blockingAcquireLeases{entered: make(chan struct{}), release: make(chan struct{})}
	releaseAcquire := sync.OnceFunc(func() { close(leases.release) })
	defer releaseAcquire()
	server.connectionLeases = leases
	httpServer := httptest.NewServer(http.HandlerFunc(server.upgrade))
	defer httpServer.Close()
	dialDone := make(chan struct{})
	go func() {
		defer close(dialDone)
		dialer := websocket.Dialer{Subprotocols: []string{"messenger", "messenger-ticket." + testWSToken(secret, strings.Repeat("a", 64))}}
		socket, _, err := dialer.Dial("ws"+strings.TrimPrefix(httpServer.URL, "http")+"/ws", nil)
		if err == nil {
			_ = socket.Close()
		}
	}()
	select {
	case <-leases.entered:
	case <-time.After(time.Second):
		t.Fatal("upgrade did not reach lease acquisition")
	}
	shutdownDone := make(chan struct{})
	go func() { server.Close(); close(shutdownDone) }()
	select {
	case <-roomsClosed:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not close rooms")
	}
	select {
	case <-shutdownDone:
		t.Fatal("shutdown returned while an upgrade was in flight")
	default:
	}
	releaseAcquire()
	select {
	case <-shutdownDone:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not join the completed upgrade")
	}
	<-dialDone
}

func TestShutdownReleasesConnectionLeasesConcurrently(t *testing.T) {
	server, _ := newSessionServer(t, &sessionRooms{}, nil)
	server.config.ShutdownTimeout = time.Second
	leases := &blockingReleaseLeases{entered: make(chan struct{}, 8), release: make(chan struct{})}
	releaseLeases := sync.OnceFunc(func() { close(leases.release) })
	defer releaseLeases()
	server.connectionLeases = leases
	for i := range 8 {
		connection := newConnection(server, nil, ticket.Identity{UserID: sessionTestUser}, "ticket")
		connection.connectionLeaseID = fmt.Sprintf("lease-%d", i)
		server.connections[connection] = struct{}{}
		server.metrics.Connections.Inc()
	}
	done := make(chan struct{})
	go func() { server.Close(); close(done) }()
	for range 2 {
		select {
		case <-leases.entered:
		case <-time.After(time.Second):
			t.Fatal("shutdown serialized lease releases")
		}
	}
	leases.mu.Lock()
	maximum := leases.maximum
	leases.mu.Unlock()
	if maximum < 2 {
		t.Fatalf("maximum concurrent lease releases = %d, want at least 2", maximum)
	}
	releaseLeases()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not complete after releases resumed")
	}
}
