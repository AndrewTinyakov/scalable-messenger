package socket

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"messenger/ws/internal/ticket"
)

func TestDrainStopsAdmissionAndSpreadsExistingCloses(t *testing.T) {
	server, _ := newSessionServer(t, &sessionRooms{}, nil)
	server.config.DrainTimeout = 100 * time.Millisecond
	for range 4 {
		connection := newConnection(server, nil, ticket.Identity{})
		server.connections[connection] = struct{}{}
		server.metrics.Connections.Inc()
	}
	ready := httptest.NewRecorder()
	server.ready(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusOK {
		t.Fatal("new server is not ready")
	}
	done := make(chan struct{})
	go func() { server.Drain(context.Background()); close(done) }()
	deadline := time.Now().Add(time.Second)
	for {
		server.mu.Lock()
		draining := server.state == serverDraining
		server.mu.Unlock()
		if draining {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("drain did not stop admission")
		}
		time.Sleep(time.Millisecond)
	}
	if server.reserveUpgrade() {
		t.Fatal("draining server admitted a connection")
	}
	ready = httptest.NewRecorder()
	server.ready(ready, httptest.NewRequest(http.MethodGet, "/readyz", nil))
	if ready.Code != http.StatusServiceUnavailable {
		t.Fatal("draining server remained ready")
	}
	server.mu.Lock()
	remaining := len(server.connections)
	server.mu.Unlock()
	if remaining != 4 {
		t.Fatalf("drain immediately closed %d connections", 4-remaining)
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("drain did not finish")
	}
	server.mu.Lock()
	remaining = len(server.connections)
	server.mu.Unlock()
	if remaining != 0 {
		t.Fatalf("remaining=%d", remaining)
	}
}
