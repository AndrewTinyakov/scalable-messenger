package socket

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
)

type sendLimiterFunc func(context.Context, string) (bool, error)

func (fn sendLimiterFunc) AllowSend(ctx context.Context, userID string) (bool, error) {
	return fn(ctx, userID)
}

type publisherFunc func(context.Context, protocol.SendCommand) error

func (fn publisherFunc) Publish(ctx context.Context, command protocol.SendCommand) error {
	return fn(ctx, command)
}

func TestReaderProcessesReceiptWhilePublishWaits(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	joined := make(chan *Connection, 1)
	rooms := &sessionRooms{join: func(recipient roomregistry.Recipient) { joined <- recipient.(*Connection) }}
	server, secret := newSessionServer(t, rooms, func(context.Context, string) (grpcauth.Session, error) {
		return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID}, nil
	})
	entered := make(chan struct{})
	release := make(chan struct{})
	server.config.ConfirmTimeout = time.Second
	server.config.MaxFrameBytes = 32768
	server.sendLimiter = sendLimiterFunc(func(context.Context, string) (bool, error) { return true, nil })
	server.publisher = publisherFunc(func(ctx context.Context, _ protocol.SendCommand) error {
		close(entered)
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	})
	socket := dialSessionSocket(t, http.HandlerFunc(server.upgrade), testWSToken(secret, sessionID))
	connection := <-joined
	if err := connection.acks.markSent(savedEvent(sessionTestUser, "1"), time.Now()); err != nil {
		t.Fatal(err)
	}
	if err := socket.WriteMessage(websocket.TextMessage, []byte(`{"type":"send","version":1,"chatId":"`+sessionTestUser+`","requestId":"`+sessionTestUser+`","body":"test"}`)); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("publish did not start")
	}
	if err := socket.WriteMessage(websocket.TextMessage, []byte(`{"type":"received_message","version":1,"chatId":"`+sessionTestUser+`","sequence":"1"}`)); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(500 * time.Millisecond)
	for !connection.acks.nextDeadline().IsZero() {
		if time.Now().After(deadline) {
			t.Fatal("receipt blocked behind publisher")
		}
		time.Sleep(time.Millisecond)
	}
	close(release)
	socket.SetReadDeadline(time.Now().Add(time.Second))
	_, payload, err := socket.ReadMessage()
	if strings.Contains(string(payload), `"type":"presence_config"`) {
		_, payload, err = socket.ReadMessage()
	}
	if err != nil || !strings.Contains(string(payload), `"type":"queued"`) {
		t.Fatalf("confirmed outcome=%s,%v", payload, err)
	}
}

func TestCommandQueueBoundsAndCloseCancelsWorker(t *testing.T) {
	entered := make(chan struct{})
	exited := make(chan struct{})
	connection := newRaceConnection(t, &raceRooms{}, nil, func(server *Server) {
		server.config.CommandWorkers = 1
		server.config.CommandQueueItems = 2
		server.config.ConnectionCommandItems = 2
		server.config.ConfirmTimeout = time.Second
		server.sendLimiter = sendLimiterFunc(func(context.Context, string) (bool, error) { return true, nil })
		server.publisher = publisherFunc(func(ctx context.Context, _ protocol.SendCommand) error {
			close(entered)
			<-ctx.Done()
			close(exited)
			return ctx.Err()
		})
	})
	command := protocol.Frame{Type: protocol.FrameSend, ChatID: sessionTestUser, RequestID: sessionTestUser, Body: "test"}
	if err := connection.enqueueCommand(command, 100); err != nil {
		t.Fatal(err)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("worker did not start")
	}
	if err := connection.enqueueCommand(command, 100); err != nil {
		t.Fatal(err)
	}
	if err := connection.enqueueCommand(command, 100); !errors.Is(err, errCommandCapacity) {
		t.Fatalf("overflow=%v", err)
	}
	connection.Close()
	select {
	case <-exited:
	case <-time.After(time.Second):
		t.Fatal("close did not cancel in-flight command")
	}
	connection.server.Close()
	connection.server.commands.mu.Lock()
	defer connection.server.commands.mu.Unlock()
	if connection.server.commands.items != 0 || connection.server.commands.bytes != 0 {
		t.Fatal("closed commands kept admission capacity")
	}
}

func TestQueuedSubscriptionDeadlineIncludesWait(t *testing.T) {
	entered := make(chan struct{})
	exited := make(chan struct{})
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, nil, func(server *Server) {
		server.config.CommandWorkers = 1
		server.config.ConfirmTimeout = 60 * time.Millisecond
		server.config.APITimeout = 10 * time.Millisecond
		server.sendLimiter = sendLimiterFunc(func(context.Context, string) (bool, error) { return true, nil })
		server.publisher = publisherFunc(func(ctx context.Context, _ protocol.SendCommand) error {
			close(entered)
			<-ctx.Done()
			close(exited)
			return ctx.Err()
		})
	})
	if err := connection.enqueueCommand(protocol.Frame{Type: protocol.FrameSend, ChatID: sessionTestUser, RequestID: sessionTestUser, Body: "test"}, 100); err != nil {
		t.Fatal(err)
	}
	<-entered
	if err := connection.enqueueCommand(protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatDirect, ChatID: sessionTestUser}, 100); err != nil {
		t.Fatal(err)
	}
	<-exited
	deadline := time.Now().Add(time.Second)
	for {
		connection.server.commands.mu.Lock()
		items := connection.server.commands.items
		connection.server.commands.mu.Unlock()
		if items == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("worker did not release completed commands")
		}
		time.Sleep(time.Millisecond)
	}
	if rooms.joins != 0 {
		t.Fatal("expired subscription performed room work")
	}
	connection.Close()
}

func TestConcurrentEnqueueAndCloseReleaseOutboundAccounting(t *testing.T) {
	connection := newRaceConnection(t, &raceRooms{}, nil)
	var writers sync.WaitGroup
	for range 16 {
		writers.Add(1)
		go func() { defer writers.Done(); connection.Enqueue(savedEvent(sessionTestUser, "1")) }()
	}
	connection.Close()
	writers.Wait()
	for name, gauge := range map[string]prometheus.Gauge{"items": connection.server.metrics.QueuedItems, "bytes": connection.server.metrics.QueuedBytes} {
		var metric dto.Metric
		if err := gauge.Write(&metric); err != nil {
			t.Fatal(err)
		}
		if value := metric.GetGauge().GetValue(); value != 0 {
			t.Fatalf("closed outbound %s=%g", name, value)
		}
	}
}
