package socket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

type blockingAdmission struct {
	entered chan struct{}
	release chan struct{}
}

func (admission *blockingAdmission) Admit(context.Context, string) (bool, error) {
	close(admission.entered)
	<-admission.release
	return true, nil
}
func (*blockingAdmission) Release(string) {}

func TestShutdownWaitsForInFlightUpgrade(t *testing.T) {
	roomsClosed := make(chan struct{})
	rooms := &sessionRooms{onClose: func() { close(roomsClosed) }}
	server, secret := newSessionServer(t, rooms, nil)
	leases := &blockingAdmission{entered: make(chan struct{}), release: make(chan struct{})}
	releaseAcquire := sync.OnceFunc(func() { close(leases.release) })
	defer releaseAcquire()
	server.admission = leases
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
