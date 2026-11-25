package socket

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/rabbitmq"
	"messenger/ws/internal/ticket"
)

type serverTestDependencies struct{}

func (serverTestDependencies) Publish(context.Context, protocol.SendCommand) error { return nil }
func (serverTestDependencies) AllowSend(context.Context, string) (bool, error)     { return true, nil }
func (serverTestDependencies) AllowHandshake(context.Context, string, int, time.Duration) (bool, error) {
	return true, nil
}
func (serverTestDependencies) AllowSubscribe(context.Context, string, int, time.Duration) (bool, error) {
	return true, nil
}
func (serverTestDependencies) AllowSubscribeBatch(context.Context, string, int, int, time.Duration) (bool, error) {
	return true, nil
}
func (serverTestDependencies) AcquireConnectionLease(context.Context, string) (string, bool, error) {
	return "", true, nil
}
func (serverTestDependencies) RenewConnectionLease(context.Context, string, string) (bool, error) {
	return true, nil
}
func (serverTestDependencies) ReleaseConnectionLease(context.Context, string, string) error {
	return nil
}
func (serverTestDependencies) AuthorizeGroup(context.Context, string, string) (string, error) {
	return "", grpcauth.ErrUnauthorized
}
func (serverTestDependencies) AuthorizeGroups(context.Context, string, []string) (map[string]bool, error) {
	return nil, grpcauth.ErrUnauthorized
}
func (serverTestDependencies) ValidateSession(context.Context, string) (grpcauth.Session, error) {
	return grpcauth.Session{}, grpcauth.ErrUnauthorized
}
func (serverTestDependencies) ValidateSessions(context.Context, []string) (map[string]grpcauth.Session, error) {
	return map[string]grpcauth.Session{}, nil
}

func testDependencies(rooms RoomCoordinator) Dependencies {
	adapter := serverTestDependencies{}
	return Dependencies{GroupAuthorizer: adapter, SessionAuthorizer: adapter, Publisher: adapter, SendLimiter: adapter, HandshakeLimiter: adapter, ConnectionLeases: adapter, SubscriptionLimiter: adapter, Rooms: rooms}
}

func newTestServer(t *testing.T, cfg config.Config, dependencies Dependencies) *Server {
	t.Helper()
	registry := prometheus.NewRegistry()
	server, err := NewServer(context.Background(), cfg, slog.New(slog.NewTextHandler(io.Discard, nil)), dependencies, registry, monitoring.New(registry))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(server.Close)
	return server
}

type lifecycleRooms struct {
	sessionRooms
	started    chan struct{}
	canceled   chan struct{}
	release    chan struct{}
	finished   chan struct{}
	closeCalls atomic.Int32
}

func (rooms *lifecycleRooms) RunChecks(ctx context.Context) {
	close(rooms.started)
	<-ctx.Done()
	close(rooms.canceled)
	<-rooms.release
	close(rooms.finished)
}

func (rooms *lifecycleRooms) Close() { rooms.closeCalls.Add(1) }

func TestServerOwnsAndJoinsInjectedRooms(t *testing.T) {
	rooms := &lifecycleRooms{started: make(chan struct{}), canceled: make(chan struct{}), release: make(chan struct{}), finished: make(chan struct{})}
	server := newTestServer(t, config.Config{MaxGroupAuths: 1, QueueItems: 8, QueueBytes: 4096}, testDependencies(rooms))
	release := sync.OnceFunc(func() { close(rooms.release) })
	t.Cleanup(release)
	select {
	case <-rooms.started:
	case <-time.After(time.Second):
		t.Fatal("room checks did not start")
	}
	done := make(chan struct{})
	go func() { server.Close(); close(done) }()
	select {
	case <-rooms.canceled:
	case <-time.After(time.Second):
		t.Fatal("room checks were not canceled")
	}
	select {
	case <-done:
		t.Fatal("server returned before room checks finished")
	default:
	}
	release()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("server did not join room checks")
	}
	select {
	case <-rooms.finished:
	default:
		t.Fatal("room checks did not finish")
	}
	server.Close()
	if got := rooms.closeCalls.Load(); got != 1 {
		t.Fatalf("room close calls = %d, want 1", got)
	}
}

func TestServerRejectsMissingDependenciesBeforeStartingRooms(t *testing.T) {
	for _, test := range []struct {
		name   string
		remove func(*Dependencies)
	}{
		{"group authorizer", func(d *Dependencies) { d.GroupAuthorizer = nil }},
		{"session authorizer", func(d *Dependencies) { d.SessionAuthorizer = nil }},
		{"publisher", func(d *Dependencies) { d.Publisher = nil }},
		{"send limiter", func(d *Dependencies) { d.SendLimiter = nil }},
		{"handshake limiter", func(d *Dependencies) { d.HandshakeLimiter = nil }},
		{"connection leases", func(d *Dependencies) { d.ConnectionLeases = nil }},
		{"subscription limiter", func(d *Dependencies) { d.SubscriptionLimiter = nil }},
		{"rooms", func(d *Dependencies) { d.Rooms = nil }},
		{"rooms", func(d *Dependencies) { var rooms *sessionRooms; d.Rooms = rooms }},
		{"session authorizer", func(d *Dependencies) { var auth sessionAuthorizerFunc; d.SessionAuthorizer = auth }},
	} {
		t.Run(test.name, func(t *testing.T) {
			rooms := &lifecycleRooms{started: make(chan struct{})}
			dependencies := testDependencies(rooms)
			test.remove(&dependencies)
			registry := prometheus.NewRegistry()
			server, err := NewServer(context.Background(), config.Config{MaxGroupAuths: 1, QueueItems: 8, QueueBytes: 4096}, slog.Default(), dependencies, registry, monitoring.New(registry))
			if server != nil || err == nil || !strings.Contains(err.Error(), test.name) {
				t.Fatalf("server = %v, error = %v", server, err)
			}
			select {
			case <-rooms.started:
				t.Fatal("invalid server started room checks")
			default:
			}
			if rooms.closeCalls.Load() != 0 {
				t.Fatal("invalid server took ownership of rooms")
			}
		})
	}
}

func TestSocketErrorCodesKeepWireAndMetricValues(t *testing.T) {
	for _, test := range []struct {
		name     string
		err      error
		code     protocol.ErrorCode
		wireCode string
	}{
		{"dependency", errors.New("dependency failure"), protocol.ErrorDependencyUnavailable, "DEPENDENCY_UNAVAILABLE"},
		{"UNAUTHORIZED", grpcauth.ErrUnauthorized, protocol.ErrorUnauthorized, "UNAUTHORIZED"},
		{"rate limit", errRateLimited, protocol.ErrorRateLimited, "RATE_LIMITED"},
		{"command capacity", errCommandCapacity, protocol.ErrorRateLimited, "RATE_LIMITED"},
		{"room limit", errRoomLimit, protocol.ErrorRoomLimit, "ROOM_LIMIT"},
		{"invalid acknowledgement", errInvalidACK, protocol.ErrorInvalidFrame, "INVALID_FRAME"},
	} {
		t.Run(test.name, func(t *testing.T) {
			server := newTestServer(t, config.Config{MaxGroupAuths: 1, QueueItems: 8, QueueBytes: 4096}, testDependencies(&sessionRooms{}))
			connection := newConnection(server, nil, ticket.Identity{}, "")
			t.Cleanup(connection.Close)
			connection.handleError(test.err, raceChatID)
			frame := (<-connection.out).frame
			if frame.Event().Type != protocol.EventError || frame.Event().Code != test.code || !strings.Contains(string(frame.Payload()), `"code":"`+test.wireCode+`"`) || frame.Event().RequestID != raceChatID {
				t.Fatalf("error frame = %s", frame.Payload())
			}
			families, err := server.registry.Gather()
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, family := range families {
				if family.GetName() == "messenger_ws_error_frames_total" {
					for _, metric := range family.Metric {
						if metric.Label[0].GetValue() == test.wireCode && metric.Counter.GetValue() == 1 {
							found = true
						}
					}
				}
			}
			if !found {
				t.Fatal("error metric did not retain the wire code")
			}
		})
	}
}

func TestSendPublishResultKeepsWireAndMetricValues(t *testing.T) {
	for _, test := range []struct {
		name      string
		err       error
		eventType protocol.EventType
		code      protocol.ErrorCode
		outcome   string
	}{
		{"confirmed", nil, protocol.EventQueued, "", "confirmed"},
		{"failed", errors.New("broker rejected request"), protocol.EventError, protocol.ErrorPublishFailed, "failed"},
		{"unknown", rabbitmq.ErrUnknownOutcome, protocol.EventError, protocol.ErrorPublishUnknown, "failed"},
	} {
		t.Run(test.name, func(t *testing.T) {
			dependencies := testDependencies(&sessionRooms{})
			dependencies.Publisher = publisherFunc(func(_ context.Context, command protocol.SendCommand) error {
				if command.ChatID != raceChatID || command.RequestID != secondRaceChatID || command.SenderID != sessionTestUser || command.Body != "hello" {
					t.Fatalf("published command = %+v", command)
				}
				return test.err
			})
			server := newTestServer(t, config.Config{MaxGroupAuths: 1, QueueItems: 8, QueueBytes: 4096, ConfirmTimeout: time.Second}, dependencies)
			connection := newConnection(server, nil, ticket.Identity{UserID: sessionTestUser}, "")
			t.Cleanup(connection.Close)
			if err := connection.enqueueCommand(protocol.Frame{Type: protocol.FrameSend, ChatID: raceChatID, RequestID: secondRaceChatID, Body: "hello"}, 100); err != nil {
				t.Fatal(err)
			}
			var frame *protocol.EventFrame
			select {
			case output := <-connection.out:
				frame = output.frame
			case <-time.After(time.Second):
				t.Fatal("command worker did not emit a result")
			}
			if frame.Event().Type != test.eventType || frame.Event().Code != test.code || frame.Event().RequestID != secondRaceChatID {
				t.Fatalf("publish response = %s", frame.Payload())
			}
			completed := time.Now().Add(time.Second)
			for {
				server.commands.mu.Lock()
				active := server.commands.items
				server.commands.mu.Unlock()
				if active == 0 {
					break
				}
				if time.Now().After(completed) {
					t.Fatal("command worker did not finish")
				}
				time.Sleep(time.Millisecond)
			}
			families, err := server.registry.Gather()
			if err != nil {
				t.Fatal(err)
			}
			found := false
			for _, family := range families {
				if family.GetName() == "messenger_ws_publish_seconds" {
					for _, metric := range family.Metric {
						if metric.Label[0].GetValue() == test.outcome && metric.Histogram.GetSampleCount() == 1 {
							found = true
						}
					}
				}
			}
			if !found {
				t.Fatal("publish metric changed its outcome label")
			}
			serviceOutcome := "success"
			if test.err != nil {
				serviceOutcome = "failed"
			}
			found = false
			for _, family := range families {
				if family.GetName() != "messenger_ws_command_service_seconds" {
					continue
				}
				for _, metric := range family.Metric {
					for _, label := range metric.Label {
						if label.GetName() == "result" && label.GetValue() == serviceOutcome && metric.Histogram.GetSampleCount() == 1 {
							found = true
						}
					}
				}
			}
			if !found {
				t.Fatalf("command service did not report %s", serviceOutcome)
			}
			if len(connection.out) != 0 {
				t.Fatal("command worker emitted more than one response")
			}
		})
	}
}
