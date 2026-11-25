package socket

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/config"
	"messenger/ws/internal/ticket"
)

func TestMissingAppliedACKClosesSocketForRecovery(t *testing.T) {
	server := newTestServer(t, config.Config{MaxGroupAuths: 8, QueueItems: 8, QueueBytes: 4096, PendingACKLimit: 8, ACKTimeout: 80 * time.Millisecond, WriteTimeout: time.Second, PingInterval: time.Hour}, testDependencies(&sessionRooms{}))
	accepted := make(chan *websocket.Conn, 1)
	httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
		if err == nil {
			accepted <- socket
		}
	}))
	defer httpServer.Close()
	client, _, err := websocket.DefaultDialer.Dial(strings.Replace(httpServer.URL, "http://", "ws://", 1), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	var socket *websocket.Conn
	select {
	case socket = <-accepted:
	case <-time.After(time.Second):
		t.Fatal("server did not accept socket")
	}
	connection := newConnection(server, socket, ticket.Identity{})
	server.connections[connection] = struct{}{}
	writerDone := make(chan struct{})
	go func() { connection.writeLoop(); close(writerDone) }()
	if !connection.Enqueue(savedEvent("chat", "1")) {
		t.Fatal("message was not queued")
	}
	_ = client.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := client.ReadMessage(); err != nil {
		t.Fatalf("read saved message: %v", err)
	}
	_, _, err = client.ReadMessage()
	var closeError *websocket.CloseError
	if !errors.As(err, &closeError) || closeError.Code != 4001 {
		t.Fatalf("close error = %v, want code 4001", err)
	}
	select {
	case <-writerDone:
	case <-time.After(time.Second):
		t.Fatal("socket writer did not stop")
	}
}
