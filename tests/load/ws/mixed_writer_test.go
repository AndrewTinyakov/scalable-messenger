package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestMixedWriterWaitCannotTransmitLateOrCancelledSends(t *testing.T) {
	for _, reason := range []string{"cancelled", "late"} {
		t.Run(reason, func(t *testing.T) {
			received := make(chan bool, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				conn, err := (&websocket.Upgrader{}).Upgrade(w, r, nil)
				if err != nil {
					received <- false
					return
				}
				defer conn.Close()
				conn.SetReadDeadline(time.Now().Add(3 * time.Second))
				_, _, err = conn.ReadMessage()
				received <- err == nil
			}))
			defer server.Close()
			conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
			if err != nil {
				t.Fatal(err)
			}
			defer conn.Close()
			chat := &mixedChat{id: "chat"}
			work := &run{opts: options{maxMessages: 1}, prefix: "capacity_writer|", mixed: &mixedWorkload{
				users: []session{{UserID: "sender"}}, chats: []*mixedChat{chat},
				schedule: []mixedSend{{chat: 0, sender: 0, bytes: 256}},
			}}
			socket := &client{owner: work, session: work.mixed.users[0], conn: conn}
			work.clients = []*client{socket}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			socket.mu.Lock()
			locked := true
			defer func() {
				if locked {
					socket.mu.Unlock()
				}
			}()
			done := make(chan error, 1)
			go func() { done <- work.measureMixed(ctx) }()
			until := time.Now().Add(500 * time.Millisecond)
			for work.attempted.Load() == 0 && time.Now().Before(until) {
				time.Sleep(time.Millisecond)
			}
			if work.attempted.Load() != 1 {
				t.Fatal("scheduled worker never attempted its send")
			}
			if reason == "cancelled" {
				cancel()
			} else {
				time.Sleep(mixedMaxSendLag + 10*time.Millisecond)
			}
			socket.mu.Unlock()
			locked = false
			select {
			case err := <-done:
				if err != nil {
					t.Fatal(err)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("workers did not join")
			}
			conn.Close()
			select {
			case sent := <-received:
				if sent {
					t.Error("transmitted a frame after its scheduling boundary")
				}
			case <-time.After(time.Second):
				t.Fatal("server reader did not finish")
			}
			if work.sent.Load() != 0 || work.errors.Load() == 0 {
				t.Errorf("sent=%d errors=%d", work.sent.Load(), work.errors.Load())
			}
			if reason == "cancelled" && work.mixed.cancelled.Load() != 1 {
				t.Errorf("cancelled=%d", work.mixed.cancelled.Load())
			}
			if reason == "late" && (work.mixed.lateDropped.Load() != 1 || time.Duration(work.mixed.maxLag.Load()) <= mixedMaxSendLag) {
				t.Errorf("late=%d maxLag=%v", work.mixed.lateDropped.Load(), time.Duration(work.mixed.maxLag.Load()))
			}
		})
	}
}
