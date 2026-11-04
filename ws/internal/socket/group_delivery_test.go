package socket

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
)

func TestGroupDeliveryUsesCurrentGrant(t *testing.T) {
	for _, eventType := range []protocol.EventType{protocol.EventMessageSaved, protocol.EventMembershipChanged, protocol.EventHistoryChanged} {
		for _, reason := range []string{"revoked", "unsubscribed", "denied renewal", "expired", "revoked then rejoined", "active"} {
			t.Run(string(eventType)+"/"+reason, func(t *testing.T) {
				if reason == "active" && eventType == protocol.EventMessageSaved {
					return
				}
				rooms := &raceRooms{}
				allowed := true
				connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(_ context.Context, _, chatID string) (string, error) {
					if !allowed {
						return "", grpcauth.ErrUnauthorized
					}
					return roomname.Group(chatID), nil
				}))
				t.Cleanup(connection.Close)
				connection.server.config.WriteTimeout = time.Second
				connection.server.config.PingInterval = time.Hour
				frame := protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID}
				if err := connection.handle(frame); err != nil {
					t.Fatal(err)
				}
				event := protocol.Event{Type: eventType, Room: roomname.Group(raceChatID), ChatID: raceChatID}
				if eventType == protocol.EventMessageSaved {
					event.Sequence = "1"
				}
				if !connection.Enqueue(event) {
					t.Fatal("authorized group frame was not queued")
				}
				switch reason {
				case "revoked", "revoked then rejoined":
					connection.Enqueue(protocol.Event{Type: protocol.EventMemberRemoved, Room: roomname.User(raceChatID), ChatID: raceChatID, MemberID: raceChatID})
				case "unsubscribed":
					connection.subscriptions.leave(raceChatID)
				case "denied renewal":
					allowed = false
					if err := connection.handle(frame); !errors.Is(err, grpcauth.ErrUnauthorized) {
						t.Fatalf("renewal error = %v, want unauthorized", err)
					}
				case "expired":
					connection.subscriptions.expireGroup(raceChatID, connection.subscriptions.leaseSerial)
				}
				before := len(connection.out)
				connection.Enqueue(event)
				if reason == "active" {
					before++
				}
				if got := len(connection.out); got != before {
					t.Fatalf("late group fanout queued %d frames, want %d", got, before)
				}
				if reason == "revoked then rejoined" {
					if err := connection.handle(frame); err != nil {
						t.Fatal(err)
					}
				}
				connection.Enqueue(protocol.Event{Type: protocol.EventError, Code: "done"})
				accepted := make(chan *websocket.Conn, 1)
				httpServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					socket, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
					if err == nil {
						accepted <- socket
					}
				}))
				t.Cleanup(httpServer.Close)
				client, _, err := websocket.DefaultDialer.Dial(strings.Replace(httpServer.URL, "http://", "ws://", 1), nil)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = client.Close() })
				connection.socket = <-accepted
				writerDone := make(chan struct{})
				go func() { connection.writeLoop(); close(writerDone) }()
				_ = client.SetReadDeadline(time.Now().Add(time.Second))
				received := 0
				for {
					var got protocol.Event
					if err := client.ReadJSON(&got); err != nil {
						t.Fatal(err)
					}
					if got.Type == eventType {
						if reason != "active" {
							t.Fatal("socket wrote queued group event after authorization ended")
						}
						received++
					}
					if got.Code == "done" {
						break
					}
				}
				if reason == "active" && received != 2 {
					t.Fatalf("wrote %d notifications, want 2", received)
				}
				if eventType != protocol.EventMessageSaved && !connection.acks.nextDeadline().IsZero() {
					t.Fatal("metadata notification created message ACK state")
				}
				connection.Close()
				select {
				case <-writerDone:
				case <-time.After(time.Second):
					t.Fatal("writer did not stop")
				}
			})
		}
	}
}

func TestUnauthorizedBatchRenewalLeavesGroups(t *testing.T) {
	allowed := true
	rooms := &raceRooms{}
	connection := newRaceConnection(t, rooms, groupAuthorizerFunc(func(_ context.Context, _, chatID string) (string, error) {
		if !allowed {
			return "", grpcauth.ErrUnauthorized
		}
		return roomname.Group(chatID), nil
	}))
	t.Cleanup(connection.Close)
	frame := protocol.Frame{Type: protocol.FrameSubscribeMany, Subscriptions: []protocol.Subscription{{ChatID: raceChatID, Kind: protocol.ChatGroup}}}
	if err := connection.handle(frame); err != nil {
		t.Fatal(err)
	}
	allowed = false
	if err := connection.handle(frame); !errors.Is(err, grpcauth.ErrUnauthorized) {
		t.Fatalf("renewal error = %v, want unauthorized", err)
	}
	if got := connection.subscriptions.room(raceChatID); got != "" {
		t.Fatalf("room after rejected authorization = %q, want empty", got)
	}
}

func TestUnusedGroupRevocationsRemainBounded(t *testing.T) {
	connection := newRaceConnection(t, &raceRooms{}, nil)
	t.Cleanup(connection.Close)
	for index := range 1000 {
		connection.subscriptions.revoke(fmt.Sprintf("chat-%d", index))
	}
	if got := len(connection.subscriptions.groups); got != 0 {
		t.Fatalf("unused group authorization entries = %d, want 0", got)
	}
}

func TestMembershipChangedUsesCurrentGroupGrant(t *testing.T) {
	connection := newRaceConnection(t, &raceRooms{}, groupAuthorizerFunc(func(_ context.Context, _, chatID string) (string, error) {
		return roomname.Group(chatID), nil
	}))
	t.Cleanup(connection.Close)
	event := protocol.Event{Type: protocol.EventMembershipChanged, Room: roomname.Group(raceChatID), ChatID: raceChatID}
	connection.Enqueue(event)
	if len(connection.out) != 0 {
		t.Fatal("notification queued without group grant")
	}
	if err := connection.handle(protocol.Frame{Type: protocol.FrameSubscribe, Kind: protocol.ChatGroup, ChatID: raceChatID}); err != nil {
		t.Fatal(err)
	}
	<-connection.out
	if !connection.Enqueue(event) {
		t.Fatal("notification enqueue failed")
	}
	got := <-connection.out
	if got.frame.Event().Type != protocol.EventMembershipChanged || got.groupGrant == nil || got.groupGrant != connection.subscriptions.groups[raceChatID] {
		t.Fatal("notification did not use current group grant")
	}

}
