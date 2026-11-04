package socket

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/ticket"
)

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
		connection := newConnection(server, nil, ticket.Identity{UserID: sessionTestUser}, fmt.Sprintf("lease-%d", i))
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
