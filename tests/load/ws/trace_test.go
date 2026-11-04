package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestTraceDrainsConcurrentRecordsAndCorrelatesSampledRequests(t *testing.T) {
	path := filepath.Join(t.TempDir(), "trace.ndjson")
	trace, err := openLatencyTrace(path, 16)
	if err != nil {
		t.Fatal(err)
	}
	requestID := ""
	for index := range 256 {
		candidate := strconv.Itoa(index)
		if trace.sampled(candidate) {
			requestID = candidate
			break
		}
	}
	if requestID == "" {
		t.Fatal("sampling selected no request IDs")
	}
	sentAt := time.Now()
	createdAt := sentAt.Add(10 * time.Millisecond).UTC().Format(time.RFC3339Nano)
	trace.record(traceRecord{Kind: "send", RequestID: requestID, SentAt: sentAt, ObservedAt: sentAt})
	trace.record(traceRecord{Kind: "queued", RequestID: requestID, ObservedAt: sentAt.Add(20 * time.Millisecond)})
	var workers sync.WaitGroup
	for index := range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			trace.record(traceRecord{Kind: "notification", Socket: index, RequestID: requestID, Sequence: "1", SentAt: sentAt, CreatedAt: createdAt, ObservedAt: sentAt.Add(30 * time.Millisecond), Source: "websocket"})
		}()
	}
	workers.Wait()
	trace.close()
	trace.close()
	if !trace.complete() {
		t.Fatalf("trace did not finish cleanly: %v", trace.report())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	var records []traceRecord
	for {
		var record traceRecord
		if err := decoder.Decode(&record); err != nil {
			if err == io.EOF {
				break
			}
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if len(records) != 10 || trace.report()["written"] != int64(10) {
		t.Fatalf("lost correlation records: %d; %v", len(records), trace.report())
	}
	if records[1].ElapsedNanos-records[0].ElapsedNanos != int64(20*time.Millisecond) {
		t.Fatalf("queued interval lost local clock: %v", records[:2])
	}
	for _, record := range records[2:] {
		if record.RequestID != requestID || !record.SentAt.Equal(sentAt) || record.CreatedAt != createdAt || record.ElapsedNanos-records[0].ElapsedNanos != int64(30*time.Millisecond) {
			t.Fatalf("notification cannot be correlated: %+v", record)
		}
	}
	info, err := os.Stat(path)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("trace permissions: %v, %v", info, err)
	}
	if _, err := openLatencyTrace(path, 1); err == nil {
		t.Fatal("overwrote an existing trace")
	}
}

func TestTraceReportsQueueAndRecordBoundsWithoutBlockingProducers(t *testing.T) {
	for _, test := range []struct {
		name       string
		maxRecords int64
		counter    string
	}{
		{"queue", 2, "queueDropped"},
		{"records", 1, "limitDropped"},
	} {
		t.Run(test.name, func(t *testing.T) {
			trace := &latencyTrace{queue: make(chan traceRecord, 1), done: make(chan struct{}), started: time.Now(), sampleEvery: 1, maxRecords: test.maxRecords}
			trace.record(traceRecord{Kind: "send", RequestID: "request", ObservedAt: time.Now()})
			trace.record(traceRecord{Kind: "queued", RequestID: "request", ObservedAt: time.Now()})
			go trace.write(discardTraceWriter{})
			trace.close()
			if trace.complete() || trace.report()[test.counter] != int64(1) || trace.report()["written"] != int64(1) {
				t.Fatalf("trace bound not reported: %v", trace.report())
			}
		})
	}
}

func TestTraceReportsFlushFailuresAndJoinsWriter(t *testing.T) {
	writer := &failedTraceWriter{}
	trace := startLatencyTrace(writer, 1, 1, 10)
	trace.record(traceRecord{Kind: "send", RequestID: "request", ObservedAt: time.Now()})
	trace.close()
	if trace.complete() || !writer.closed || !strings.Contains(trace.report()["writeError"].(string), "disk full") {
		t.Fatalf("trace hid writer failure: %v", trace.report())
	}
}

type discardTraceWriter struct{}

func (discardTraceWriter) Write(data []byte) (int, error) { return len(data), nil }
func (discardTraceWriter) Close() error                   { return nil }

type failedTraceWriter struct{ closed bool }

func (*failedTraceWriter) Write([]byte) (int, error) { return 0, errors.New("disk full") }
func (writer *failedTraceWriter) Close() error {
	writer.closed = true
	return nil
}

func TestSocketTraceCorrelatesPublishQueuedAndNotificationWithoutBody(t *testing.T) {
	createdAt := "2026-11-03T10:00:00.123456Z"
	serverDone := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
		if err != nil {
			serverDone <- err
			return
		}
		defer conn.Close()
		var sent event
		if err := conn.ReadJSON(&sent); err != nil {
			serverDone <- err
			return
		}
		if err := conn.WriteJSON(event{Type: "queued", RequestID: sent.RequestID}); err != nil {
			serverDone <- err
			return
		}
		if err := conn.WriteJSON(event{Type: "message_saved", RequestID: sent.RequestID, EventID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", ChatID: sent.ChatID, Sequence: "1", Body: sent.Body, CreatedAt: createdAt}); err != nil {
			serverDone <- err
			return
		}
		var ack event
		if err := conn.ReadJSON(&ack); err != nil {
			serverDone <- err
			return
		}
		if ack.Type != "applied" || ack.Sequence != "1" {
			serverDone <- errors.New("missing application acknowledgement")
			return
		}
		serverDone <- nil
	}))
	defer server.Close()
	path := filepath.Join(t.TempDir(), "socket.ndjson")
	trace, err := openLatencyTrace(path, 1)
	if err != nil {
		t.Fatal(err)
	}
	defer trace.close()
	work := &run{opts: options{rate: 20, maxMessages: 1, payloadBytes: 80}, prefix: "capacity_test|", manifest: manifest{GroupID: "chat"}, trace: trace}
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	socket := &client{owner: work, conn: conn, index: 7, session: session{UserID: "sender"}}
	socket.connected.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	readDone := make(chan error, 1)
	go func() { readDone <- socket.read(ctx, conn) }()
	work.publish(ctx, socket)
	select {
	case err := <-serverDone:
		if err != nil {
			t.Fatal(err)
		}
	case <-ctx.Done():
		t.Fatal("timed out waiting for publish acknowledgement")
	}
	select {
	case <-readDone:
	case <-ctx.Done():
		t.Fatal("socket reader did not exit")
	}
	trace.close()
	if !trace.complete() || work.sent.Load() != 1 || work.queued.Load() != 1 || socket.delivered.Load() != 1 {
		t.Fatalf("incomplete socket measurements: sent=%d queued=%d delivered=%d trace=%v", work.sent.Load(), work.queued.Load(), socket.delivered.Load(), trace.report())
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var records []traceRecord
	for _, line := range bytes.Split(bytes.TrimSpace(data), []byte("\n")) {
		var record traceRecord
		if err := json.Unmarshal(line, &record); err != nil {
			t.Fatal(err)
		}
		records = append(records, record)
	}
	if len(records) != 3 || records[0].Kind != "send" || records[1].Kind != "queued" || records[2].Kind != "notification" {
		t.Fatalf("unexpected trace records: %+v", records)
	}
	if records[0].RequestID == "" || records[0].RequestID != records[1].RequestID || records[0].RequestID != records[2].RequestID || !records[0].SentAt.Equal(records[2].SentAt) || records[2].CreatedAt != createdAt || records[2].Socket != 7 || records[2].Source != "websocket" {
		t.Fatalf("socket timing lost correlation fields: %+v", records)
	}
	if records[2].EventID != "01ARZ3NDEKTSV4RRFFQ69G5FAV" {
		t.Fatalf("notification trace event ID = %q", records[2].EventID)
	}
	if bytes.Contains(data, []byte("capacity_test")) || bytes.Contains(data, []byte(`"body"`)) || bytes.Contains(data, []byte(`"cookie"`)) {
		t.Fatal("trace exposed message body or credentials")
	}
}
