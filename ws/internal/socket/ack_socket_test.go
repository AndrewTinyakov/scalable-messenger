package socket

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"messenger/ws/internal/apiclient"
	"messenger/ws/internal/config"
	"messenger/ws/internal/monitoring"
	roomregistry "messenger/ws/internal/room"
)

func TestMissingAppliedACKClosesSocketForRecovery(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := monitoring.New(registry)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	server := &Server{config: config.Config{QueueItems: 8, QueueBytes: 4096, PendingACKLimit: 8, ACKTimeout: 80 * time.Millisecond, WriteTimeout: time.Second, PingInterval: time.Hour}, metrics: metrics, rooms: roomregistry.NewRooms(nil, logger, 1, 8, time.Minute, metrics), ctx: ctx, cancel: cancel, connections: make(map[*Connection]struct{})}
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
	connection := newConnection(server, socket, apiclient.Session{}, "token")
	server.connections[connection] = struct{}{}
	writerDone := make(chan struct{})
	go func() { connection.writeLoop(); close(writerDone) }()
	if !connection.Enqueue(savedEvent("conversation", "1")) {
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
