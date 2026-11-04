package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestRecoveryTraceCorrelatesRequestlessHTTPMessagesBySenderAndTimestamp(t *testing.T) {
	path := filepath.Join(t.TempDir(), "recovery.ndjson")
	trace, err := openLatencyTrace(path, 16)
	if err != nil {
		t.Fatal(err)
	}
	defer trace.close()
	var sampledIDs []string
	unsampledID := ""
	for index := range 256 {
		requestID := strconv.Itoa(index)
		if trace.sampled(requestID) && len(sampledIDs) < 2 {
			sampledIDs = append(sampledIDs, requestID)
		} else if !trace.sampled(requestID) {
			unsampledID = requestID
		}
	}
	if len(sampledIDs) != 2 || unsampledID == "" {
		t.Fatal("could not select sampling fixtures")
	}
	sentAt := time.Now()
	body := "capacity_recovery|" + strconv.FormatInt(sentAt.UnixNano(), 10) + "|private-body"
	createdAt := sentAt.Add(time.Millisecond).UTC().Format(time.RFC3339Nano)
	senders := []string{"sender-private-a", "sender-private-b", "sender-private-c"}
	requestIDs := []string{sampledIDs[0], sampledIDs[1], unsampledID}
	for index, senderID := range senders {
		trace.recordSend(traceRecord{Kind: "send", RequestID: requestIDs[index], SentAt: sentAt, ObservedAt: sentAt}, senderID)
	}
	acknowledged := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.URL.Path == "/socket" {
			conn, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
			if err != nil {
				acknowledged <- err
				return
			}
			defer conn.Close()
			conn.SetReadDeadline(time.Now().Add(5 * time.Second))
			for index := range 3 {
				var ack event
				if err := conn.ReadJSON(&ack); err != nil {
					acknowledged <- err
					return
				}
				if ack.Type != "applied" || ack.Sequence != strconv.Itoa(index+1) {
					acknowledged <- fmt.Errorf("unexpected recovery acknowledgement: %+v", ack)
					return
				}
			}
			acknowledged <- nil
			return
		}
		if request.URL.Path != "/v1/chats/chat/messages" || request.URL.Query().Get("afterSeq") != "0" {
			http.Error(writer, "unexpected history request", http.StatusBadRequest)
			return
		}
		var messages []map[string]any
		for index, senderID := range senders {
			messages = append(messages, map[string]any{"id": strconv.Itoa(index + 1), "chatId": "chat", "sequence": strconv.Itoa(index + 1), "senderId": senderID, "body": body, "createdAt": createdAt})
		}
		writer.Header().Set("Content-Type", "application/json")
		json.NewEncoder(writer).Encode(map[string]any{"messages": messages, "nextSequence": "3", "hasMore": false})
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http")+"/socket", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	work := &run{opts: options{apiURL: server.URL}, http: server.Client(), prefix: "capacity_recovery|", manifest: manifest{GroupID: "chat"}, trace: trace}
	socket := &client{owner: work, conn: conn, index: 4, session: session{Cookie: "messenger_session=private-cookie"}}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := socket.recover(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-acknowledged:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("recovery acknowledgements did not complete")
	}
	trace.close()
	report := trace.report()
	if !trace.complete() || report["recoveryCorrelated"] != int64(2) || report["recoverySkippedUnsampled"] != int64(1) || report["missingRequestIDs"] != int64(0) || report["sendIndexEntries"] != 3 {
		t.Fatalf("valid HTTP recovery failed trace correlation: %v", report)
	}
	if socket.delivered.Load() != 3 || socket.sequence != 3 || work.latencyObserved.Load() != 3 {
		t.Fatalf("trace changed recovery progress: delivered=%d sequence=%d observed=%d", socket.delivered.Load(), socket.sequence, work.latencyObserved.Load())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	var notifications []traceRecord
	for {
		var record traceRecord
		if err := decoder.Decode(&record); err != nil {
			if err == io.EOF {
				break
			}
			t.Fatal(err)
		}
		if record.Kind == "notification" {
			notifications = append(notifications, record)
		}
	}
	if len(notifications) != 2 {
		t.Fatalf("recovered sampled notifications = %+v", notifications)
	}
	for index, record := range notifications {
		if record.RequestID != sampledIDs[index] || record.Sequence != strconv.Itoa(index+1) || record.Source != "recovery" || record.CreatedAt != createdAt || !record.SentAt.Equal(sentAt) || record.Socket != 4 {
			t.Fatalf("recovery mixed senders with the same timestamp: %+v", notifications)
		}
	}
	for _, private := range []string{"sender-private", "private-body", "private-cookie", `"senderId"`, `"body"`, `"cookie"`} {
		if bytes.Contains(data, []byte(private)) {
			t.Fatalf("trace exposed private field %q", private)
		}
	}
}

func TestRecoveryTraceRejectsIndexOverflowAndAmbiguousSendKeys(t *testing.T) {
	for _, test := range []struct {
		name          string
		maxKeys       int
		sampleEvery   int
		firstRequest  string
		secondRequest string
		secondUser    string
		counter       string
		recovery      string
		written       int64
	}{
		{"overflow", 1, 1, "request-a", "request-b", "sender-b", "sendIndexOverflow", "recoveryUnmatched", 2},
		{"collision", 2, 1, "request-a", "request-b", "sender-a", "sendIndexCollisions", "recoveryAmbiguous", 2},
		{"unsampled collision", 2, 16, "0", "5", "sender-a", "sendIndexCollisions", "recoveryAmbiguous", 1},
	} {
		t.Run(test.name, func(t *testing.T) {
			trace := startLatencyTrace(discardTraceWriter{}, test.sampleEvery, 16, 16)
			defer trace.close()
			trace.maxSendKeys = test.maxKeys
			sentAt := time.Now()
			trace.recordSend(traceRecord{Kind: "send", RequestID: test.firstRequest, SentAt: sentAt, ObservedAt: sentAt}, "sender-a")
			trace.recordSend(traceRecord{Kind: "send", RequestID: test.secondRequest, SentAt: sentAt, ObservedAt: sentAt}, test.secondUser)
			work := &run{prefix: "capacity_bound|", trace: trace}
			socket := &client{owner: work}
			err := socket.saved(event{Sequence: "1", SenderID: test.secondUser, Body: "capacity_bound|" + strconv.FormatInt(sentAt.UnixNano(), 10) + "|"})
			if err == nil || err.Error() != "socket is reconnecting" {
				t.Fatalf("expected the disconnected acknowledgement boundary, got %v", err)
			}
			trace.close()
			report := trace.report()
			if trace.complete() || report[test.counter] != int64(1) || report[test.recovery] != int64(1) || report["recoveryCorrelated"] != int64(0) || report["written"] != test.written || report["sendIndexEntries"].(int) > test.maxKeys {
				t.Fatalf("unsafe recovery correlation was accepted: %v", report)
			}
		})
	}
}

func TestLiveNotificationWithoutRequestIDStillFailsTraceIntegrity(t *testing.T) {
	trace := startLatencyTrace(discardTraceWriter{}, 1, 16, 16)
	defer trace.close()
	sentAt := time.Now()
	trace.recordSend(traceRecord{Kind: "send", RequestID: "request", SentAt: sentAt, ObservedAt: sentAt}, "sender")
	work := &run{prefix: "capacity_live|", trace: trace}
	socket := &client{owner: work}
	err := socket.savedAt(event{Sequence: "1", SenderID: "sender", Body: "capacity_live|" + strconv.FormatInt(sentAt.UnixNano(), 10) + "|"}, time.Now(), "websocket")
	if err == nil || err.Error() != "socket is reconnecting" {
		t.Fatalf("expected the disconnected acknowledgement boundary, got %v", err)
	}
	trace.close()
	if trace.complete() || trace.report()["missingRequestIDs"] != int64(1) || trace.report()["recoveryCorrelated"] != int64(0) {
		t.Fatalf("live notification guessed a request ID: %v", trace.report())
	}
}
