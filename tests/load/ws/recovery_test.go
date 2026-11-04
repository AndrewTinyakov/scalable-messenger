package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestDuplicateLaterSequenceCannotHideMissingNotification(t *testing.T) {
	work := &run{prefix: "capacity_test|"}
	socket := &client{owner: work, sequence: 1}
	for range 2 {
		if err := socket.saved(event{Sequence: "3", Body: "capacity_test|0|"}); err == nil {
			t.Fatal("accepted a notification while sequence 2 was missing")
		}
	}
	if socket.delivered.Load() != 0 || socket.sequence != 1 {
		t.Fatalf("counted a gap as progress: delivered %d, sequence %d", socket.delivered.Load(), socket.sequence)
	}
}

func TestCertifiedRecoverySkipsAbsentSequencesWithoutInventingNotifications(t *testing.T) {
	acks := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/socket" {
			conn, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
			if err != nil {
				acks <- err
				return
			}
			defer conn.Close()
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			for _, sequence := range []string{"1", "3", "100"} {
				var ack event
				if err := conn.ReadJSON(&ack); err != nil {
					acks <- err
					return
				}
				if ack.Type != "applied" || ack.Sequence != sequence {
					acks <- fmt.Errorf("unexpected ACK %+v", ack)
					return
				}
			}
			acks <- nil
			return
		}
		switch request.URL.Query().Get("afterSeq") {
		case "0":
			json.NewEncoder(writer).Encode(historyPage{Messages: []event{{ChatID: "chat", Sequence: "1", Body: "bench|0|"}, {ChatID: "chat", Sequence: "3", Body: "bench|0|"}}, HasMore: true, NextSequence: "3", CoverageAfterSequence: "0", CoverageThroughSequence: "3"})
		case "3":
			json.NewEncoder(writer).Encode(historyPage{Messages: []event{}, NextSequence: "100", CoverageAfterSequence: "3", CoverageThroughSequence: "100"})
		default:
			http.Error(writer, "wrong cursor", 400)
		}
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/socket", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	work := &run{opts: options{apiURL: server.URL}, http: server.Client(), prefix: "bench|", manifest: manifest{GroupID: "chat"}}
	socket := &client{owner: work, conn: conn}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := socket.recover(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-acks; err != nil {
		t.Fatal(err)
	}
	if socket.sequence != 100 || socket.delivered.Load() != 2 {
		t.Fatalf("invented notification from certified absence: sequence=%d notifications=%d", socket.sequence, socket.delivered.Load())
	}
}

func TestInvalidCoverageDoesNotAdvanceRecovery(t *testing.T) {
	for _, page := range []historyPage{
		{CoverageAfterSequence: "0", CoverageThroughSequence: "5", NextSequence: "5"},
		{CoverageAfterSequence: "1", CoverageThroughSequence: "5", NextSequence: "6"},
		{CoverageAfterSequence: "1", CoverageThroughSequence: "5", NextSequence: "5", Messages: []event{{ChatID: "chat", Sequence: "6"}}},
	} {
		progress := &chatProgress{sequence: 1}
		socket := &client{owner: &run{}}
		if err := socket.applyHistoryPage("chat", progress, page); err == nil {
			t.Fatal("accepted invalid sparse coverage")
		}
		if progress.sequence != 1 {
			t.Fatal("invalid coverage advanced sequence")
		}
	}
}
