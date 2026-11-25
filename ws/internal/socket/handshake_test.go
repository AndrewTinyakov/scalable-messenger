package socket

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	roomregistry "messenger/ws/internal/room"
)

type handshakeAdmissionResult struct {
	serverTestDependencies
	allowed bool
	err     error
}

func (result handshakeAdmissionResult) Admit(context.Context, string) (bool, error) {
	return result.allowed, result.err
}

func TestHandshakeSetupAcceptedBeforeSocketCloses(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	rooms := &sessionRooms{join: func(recipient roomregistry.Recipient) {
		recipient.Enqueue(protocol.Event{Type: "chat_created", Version: 1, ChatID: sessionTestUser})
	}}
	server, secret := newSessionServer(t, rooms, func(context.Context, string) (grpcauth.Session, error) {
		return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID}, nil
	})
	done := make(chan struct{})
	socket := dialSessionSocket(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		server.upgrade(w, r)
		close(done)
	}), testWSToken(secret, sessionID))
	_ = socket.SetReadDeadline(time.Now().Add(time.Second))
	if _, _, err := socket.ReadMessage(); err != nil {
		t.Fatalf("read queued room event: %v", err)
	}
	select {
	case <-done:
		t.Fatal("upgrade handler returned while socket was open")
	default:
	}
	before := assertHandshakeMetrics(t, server, "accepted", map[string]string{
		"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready",
		"user_room_join": "ready", "session_validation": "ready",
	})
	_ = socket.Close()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("upgrade handler did not finish after socket closed")
	}
	after := assertHandshakeMetrics(t, server, "accepted", map[string]string{
		"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready",
		"user_room_join": "ready", "session_validation": "ready",
	})
	if before != after {
		t.Fatalf("setup duration changed after socket closed: before=%v after=%v", before, after)
	}
}

func TestHandshakeSetupRejectsBeforeUpgrade(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(*Server, *http.Request)
		status    int
		result    string
		stages    map[string]string
	}{
		{"invalid ticket", func(_ *Server, request *http.Request) { request.Header.Del("Sec-WebSocket-Protocol") }, http.StatusUnauthorized, "invalid_ticket", map[string]string{"admission": "invalid_ticket"}},
		{"invalid origin", func(_ *Server, request *http.Request) { request.Header.Set("Origin", "https://denied.example") }, http.StatusForbidden, "invalid_origin", map[string]string{"admission": "invalid_origin"}},
		{"capacity", func(server *Server, _ *http.Request) { server.config.MaxConnections = 0 }, http.StatusServiceUnavailable, "capacity", map[string]string{"admission": "capacity"}},
		{"rate limit", func(server *Server, _ *http.Request) {
			server.handshakeLimiter = handshakeLimiterFunc(func(context.Context, string, int, time.Duration) (bool, error) { return false, nil })
		}, http.StatusTooManyRequests, "handshake_rate_limited", map[string]string{"admission": "handshake_rate_limited"}},
		{"limiter unavailable", func(server *Server, _ *http.Request) {
			server.handshakeLimiter = handshakeLimiterFunc(func(context.Context, string, int, time.Duration) (bool, error) {
				return false, errors.New("Redis unavailable")
			})
		}, http.StatusServiceUnavailable, "handshake_limit_unavailable", map[string]string{"admission": "handshake_limit_unavailable"}},
		{"lease unavailable", func(server *Server, _ *http.Request) {
			server.admission = handshakeAdmissionResult{err: errors.New("Redis unavailable")}
		}, http.StatusServiceUnavailable, "admission_unavailable", map[string]string{"admission": "ready", "connection_admission": "admission_unavailable"}},
		{"user capacity", func(server *Server, _ *http.Request) { server.admission = handshakeAdmissionResult{} }, http.StatusTooManyRequests, "user_capacity", map[string]string{"admission": "ready", "connection_admission": "user_capacity"}},
		{"upgrade failure", func(*Server, *http.Request) {}, http.StatusBadRequest, "upgrade_error", map[string]string{"admission": "ready", "connection_admission": "ready", "http_upgrade": "upgrade_error"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			server, secret := newSessionServer(t, &sessionRooms{}, nil)
			request := httptest.NewRequest(http.MethodGet, "/ws", nil)
			request.Header.Set("Sec-WebSocket-Protocol", "messenger, messenger-ticket."+testWSToken(secret, strings.Repeat("a", 64)))
			test.configure(server, request)
			response := httptest.NewRecorder()
			server.upgrade(response, request)
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			assertHandshakeMetrics(t, server, test.result, test.stages)
		})
	}
}

func TestHandshakeSetupFailsAfterUpgrade(t *testing.T) {
	for _, test := range []struct {
		name      string
		configure func(*Server, *sessionRooms)
		result    string
		stages    map[string]string
	}{
		{"room unavailable", func(_ *Server, rooms *sessionRooms) { rooms.joinErr = errors.New("room unavailable") }, "room_join_failed", map[string]string{"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready", "user_room_join": "room_join_failed"}},
		{"session revoked", func(*Server, *sessionRooms) {}, "session_revoked", map[string]string{"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready", "user_room_join": "ready", "session_validation": "session_revoked"}},
		{"session unavailable", func(server *Server, _ *sessionRooms) {
			server.sessionAuth = sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) {
				return grpcauth.Session{}, errors.New("gRPC unavailable")
			})
		}, "session_unavailable", map[string]string{"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready", "user_room_join": "ready", "session_validation": "session_unavailable"}},
		{"session mismatch", func(server *Server, _ *sessionRooms) {
			server.sessionAuth = sessionAuthorizerFunc(func(context.Context, string) (grpcauth.Session, error) { return grpcauth.Session{}, nil })
		}, "session_mismatch", map[string]string{"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready", "user_room_join": "ready", "session_validation": "session_mismatch"}},
		{"canceled during join", func(server *Server, rooms *sessionRooms) {
			rooms.join = func(recipient roomregistry.Recipient) { recipient.(*Connection).Close() }
			server.sessionAuth = sessionAuthorizerFunc(func(_ context.Context, sessionID string) (grpcauth.Session, error) {
				return grpcauth.Session{UserID: sessionTestUser, DeviceID: "device", SessionID: sessionID}, nil
			})
		}, "canceled", map[string]string{"admission": "ready", "connection_admission": "ready", "http_upgrade": "ready", "user_room_join": "ready", "session_validation": "ready"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			rooms := &sessionRooms{}
			server, secret := newSessionServer(t, rooms, nil)
			test.configure(server, rooms)
			done := make(chan struct{})
			socket := dialSessionSocket(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				server.upgrade(w, r)
				close(done)
			}), testWSToken(secret, strings.Repeat("a", 64)))
			_ = socket.SetReadDeadline(time.Now().Add(time.Second))
			if _, _, err := socket.ReadMessage(); err == nil {
				t.Fatal("failed setup left the socket open")
			}
			select {
			case <-done:
			case <-time.After(time.Second):
				t.Fatal("failed setup did not return")
			}
			assertHandshakeMetrics(t, server, test.result, test.stages)
		})
	}
}

func assertHandshakeMetrics(t *testing.T, server *Server, result string, stages map[string]string) float64 {
	t.Helper()
	families, err := server.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	foundSetup := false
	var duration float64
	observedStages := make(map[string]string)
	for _, family := range families {
		if family.GetName() != "messenger_ws_handshake_setup_seconds" && family.GetName() != "messenger_ws_handshake_stage_seconds" {
			continue
		}
		for _, metric := range family.Metric {
			labels := make(map[string]string)
			for _, label := range metric.Label {
				labels[label.GetName()] = label.GetValue()
			}
			if metric.Histogram.GetSampleCount() != 1 {
				t.Fatalf("%s %v count = %d, want 1", family.GetName(), labels, metric.Histogram.GetSampleCount())
			}
			if family.GetName() == "messenger_ws_handshake_setup_seconds" {
				if foundSetup || labels["result"] != result {
					t.Fatalf("setup labels = %v, want result=%s once", labels, result)
				}
				foundSetup = true
				duration = metric.Histogram.GetSampleSum()
			} else {
				if _, exists := observedStages[labels["stage"]]; exists {
					t.Fatalf("stage observed with multiple outcomes: %v", labels)
				}
				observedStages[labels["stage"]] = labels["result"]
			}
		}
	}
	if !foundSetup || duration <= 0 || len(observedStages) != len(stages) {
		t.Fatalf("setup found=%t duration=%v stages=%v, want stages=%v", foundSetup, duration, observedStages, stages)
	}
	for stage, outcome := range stages {
		if observedStages[stage] != outcome {
			t.Fatalf("stage %s = %s, want %s", stage, observedStages[stage], outcome)
		}
	}
	return duration
}
