package redisroom

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestRoomSlotMatchesRedisCRC16(t *testing.T) {
	if got := roomSlot("123456789"); got != 12739 {
		t.Fatalf("slot = %d, want 12739", got)
	}
}

func TestIdleListenersUseOnlyInlineEventStorage(t *testing.T) {
	group := &subscriptionGroup{}
	listeners := make([]*Listener, 10_000)
	for i := range listeners {
		listeners[i] = newListener(group, fmt.Sprintf("group:%d", i))
		if &listeners[i].pending[0] != &listeners[i].inline[0] {
			t.Fatalf("idle listener %d allocated a separate event buffer", i)
		}
	}
	if !listeners[0].enqueue(Live{StreamID: "1-0"}, 1) {
		t.Fatal("first event was rejected")
	}
	if &listeners[0].pending[0] != &listeners[0].inline[0] {
		t.Fatal("first event allocated a separate event buffer")
	}
	for i, listener := range listeners[1:] {
		if &listener.pending[0] != &listener.inline[0] {
			t.Fatalf("idle listener %d allocated a separate event buffer", i+1)
		}
	}
}

func TestListenerEventBufferPreservesOrderAndBoundsBurst(t *testing.T) {
	group := &subscriptionGroup{}
	listener := newListener(group, "group:test")
	ctx := context.Background()
	for i := range roomEventBufferLimit / 2 {
		if !listener.enqueue(Live{StreamID: fmt.Sprint(i)}, 1) {
			t.Fatalf("event %d was rejected before the buffer limit", i)
		}
	}
	for i := range roomEventBufferLimit / 4 {
		live, err := listener.Receive(ctx)
		if err != nil || live.StreamID != fmt.Sprint(i) {
			t.Fatalf("receive %d: stream ID = %q, error = %v", i, live.StreamID, err)
		}
	}
	for i := roomEventBufferLimit / 2; i < roomEventBufferLimit+roomEventBufferLimit/4; i++ {
		if !listener.enqueue(Live{StreamID: fmt.Sprint(i)}, 1) {
			t.Fatalf("event %d was rejected before the buffer limit", i)
		}
	}
	if got := listener.queued; got != roomEventBufferLimit {
		t.Fatalf("queued events = %d, want %d", got, roomEventBufferLimit)
	}
	if listener.enqueue(Live{StreamID: "overflow"}, 1) {
		t.Fatal("event beyond the buffer limit was accepted")
	}
	for i := roomEventBufferLimit / 4; i < roomEventBufferLimit+roomEventBufferLimit/4; i++ {
		live, err := listener.Receive(ctx)
		if err != nil || live.StreamID != fmt.Sprint(i) {
			t.Fatalf("receive %d: stream ID = %q, error = %v", i, live.StreamID, err)
		}
	}
	if got := listener.queued; got != 0 {
		t.Fatalf("queued events after drain = %d, want 0", got)
	}
	if &listener.pending[0] != &listener.inline[0] {
		t.Fatal("drained listener retained the burst buffer")
	}
}

func TestListenerEventBufferLimitsBytes(t *testing.T) {
	listener := newListener(&subscriptionGroup{}, "group:test")
	size := roomEventBufferByteLimit/2 + 1
	if !listener.enqueue(Live{StreamID: "1-0"}, size) {
		t.Fatal("first event rejected")
	}
	if listener.enqueue(Live{StreamID: "2-0"}, size) {
		t.Fatal("second event exceeded byte limit")
	}
	if live, err := listener.Receive(context.Background()); err != nil || live.StreamID != "1-0" {
		t.Fatalf("receive = %+v, %v", live, err)
	}
	if listener.queuedBytes != 0 || !listener.enqueue(Live{StreamID: "2-0"}, size) {
		t.Fatal("drain did not release byte capacity")
	}
}

func TestListenerReceiveWakesAndStops(t *testing.T) {
	group := &subscriptionGroup{}
	listener := newListener(group, "group:test")
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	type result struct {
		live Live
		err  error
	}
	received := make(chan result, 1)
	go func() {
		live, err := listener.Receive(ctx)
		received <- result{live, err}
	}()
	group.mu.Lock()
	listener.enqueue(Live{StreamID: "1-0"}, 1)
	group.mu.Unlock()
	select {
	case got := <-received:
		if got.err != nil || got.live.StreamID != "1-0" {
			t.Fatalf("receive = %+v, want stream ID 1-0", got)
		}
	case <-ctx.Done():
		t.Fatal("receive did not wake for an event")
	}
	stopped := make(chan result, 1)
	go func() {
		live, err := listener.Receive(ctx)
		stopped <- result{live, err}
	}()
	want := errors.New("feed stopped")
	group.mu.Lock()
	listener.stop(want)
	group.mu.Unlock()
	select {
	case got := <-stopped:
		if !errors.Is(got.err, want) {
			t.Fatalf("receive error = %v, want %v", got.err, want)
		}
	case <-ctx.Done():
		t.Fatal("receive did not wake when the listener stopped")
	}
}

func TestSharedRedisSubscriptions(t *testing.T) {
	url := os.Getenv("REDIS_TEST_URL")
	cluster := os.Getenv("REDIS_TEST_CLUSTER_NODES")
	if url == "" && cluster == "" {
		t.Skip("set REDIS_TEST_URL or REDIS_TEST_CLUSTER_NODES to run against Redis")
	}
	var nodes []string
	if cluster != "" {
		nodes = strings.Split(cluster, ",")
	}
	client, err := New(url, nodes)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	rooms := []string{
		"user:01ARZ3NDEKTSV4RRFFQ69G5FA1",
		"user:01ARZ3NDEKTSV4RRFFQ69G5FA2",
		"user:01ARZ3NDEKTSV4RRFFQ69G5FA3",
		"user:01ARZ3NDEKTSV4RRFFQ69G5FA4",
	}
	listeners := make([]*Listener, 0, len(rooms))
	for _, room := range rooms {
		listener, err := client.Subscribe(ctx, room)
		if err != nil {
			t.Fatalf("subscribe %s: %v", room, err)
		}
		listeners = append(listeners, listener)
		defer listener.Close()
	}
	client.subs.mu.Lock()
	groupCount := len(client.subs.groups)
	client.subs.mu.Unlock()
	if groupCount >= len(rooms) {
		t.Fatalf("%d rooms created %d PubSub connections", len(rooms), groupCount)
	}
	for i, room := range rooms {
		publishTestEvent(t, ctx, client, room, i)
		live, err := listeners[i].Receive(ctx)
		if err != nil || live.Event.Room != room || live.Event.Type != "chat_created" {
			t.Fatalf("receive %s: event=%+v error=%v", room, live.Event, err)
		}
	}
	if err := listeners[0].Close(); err != nil {
		t.Fatal(err)
	}
	publishTestEvent(t, ctx, client, rooms[1], 5)
	if live, err := listeners[1].Receive(ctx); err != nil || live.Event.Room != rooms[1] {
		t.Fatalf("remaining room stopped after another left: event=%+v error=%v", live.Event, err)
	}
}

func TestRapidRoomRejoinWaitsForUnsubscribe(t *testing.T) {
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("set REDIS_TEST_URL to run against Redis")
	}
	client, err := New(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	room := "user:01ARZ3NDEKTSV4RRFFQ69G5F11"
	keepRoom := "user:01ARZ3NDEKTSV4RRFFQ69G5F12"
	group, err := client.subs.group(ctx, room)
	if err != nil {
		t.Fatal(err)
	}
	started := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	releaseUnsubscribe := func() { releaseOnce.Do(func() { close(release) }) }
	defer releaseUnsubscribe()
	original := group.unsubscribe
	var once sync.Once
	group.unsubscribe = func(ctx context.Context, channel string) error {
		if channel == Channel(room) {
			once.Do(func() {
				close(started)
				<-release
			})
		}
		return original(ctx, channel)
	}
	keep, err := client.Subscribe(ctx, keepRoom)
	if err != nil {
		t.Fatal(err)
	}
	defer keep.Close()
	first, err := client.Subscribe(ctx, room)
	if err != nil {
		t.Fatal(err)
	}
	closed := make(chan struct{})
	go func() {
		_ = first.Close()
		close(closed)
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("unsubscribe did not start")
	}
	type subscribeResult struct {
		listener *Listener
		err      error
	}
	rejoined := make(chan subscribeResult, 1)
	go func() {
		listener, err := client.Subscribe(ctx, room)
		rejoined <- subscribeResult{listener, err}
	}()
	select {
	case <-rejoined:
		t.Fatal("rejoin completed before the prior unsubscribe")
	case <-time.After(100 * time.Millisecond):
	}
	releaseUnsubscribe()
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("unsubscribe did not finish")
	}
	var second *Listener
	select {
	case result := <-rejoined:
		if result.err != nil {
			t.Fatal(result.err)
		}
		second = result.listener
	case <-ctx.Done():
		t.Fatal("rejoin did not finish")
	}
	defer second.Close()
	publishTestEvent(t, ctx, client, room, 17)
	if live, err := second.Receive(ctx); err != nil || live.Event.Room != room {
		t.Fatalf("rejoined listener receive: event=%+v error=%v", live.Event, err)
	}
}

func TestLastListenerRejoinWaitsForClosedGroupToDrop(t *testing.T) {
	url := os.Getenv("REDIS_TEST_URL")
	if url == "" {
		t.Skip("set REDIS_TEST_URL to run against Redis")
	}
	client, err := New(url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	room := "user:01ARZ3NDEKTSV4RRFFQ69G5F13"
	first, err := client.Subscribe(ctx, room)
	if err != nil {
		t.Fatal(err)
	}
	group := first.group
	group.mu.Lock()
	delete(group.listeners, Channel(room))
	first.stop(errSubscriptionClosed)
	group.state = subscriptionClosed
	group.mu.Unlock()
	// Model the interval after the last listener marks the group closed but
	// before its PubSub close removes it from the hub.
	type result struct {
		listener *Listener
		err      error
	}
	rejoined := make(chan result, 1)
	go func() {
		listener, err := client.Subscribe(ctx, room)
		rejoined <- result{listener, err}
	}()
	select {
	case got := <-rejoined:
		t.Fatalf("rejoin returned before old group dropped: %+v", got)
	case <-time.After(50 * time.Millisecond):
	}
	group.close()
	select {
	case got := <-rejoined:
		if got.err != nil {
			t.Fatal(got.err)
		}
		defer got.listener.Close()
		publishTestEvent(t, ctx, client, room, 18)
		if live, err := got.listener.Receive(ctx); err != nil || live.Event.Room != room {
			t.Fatalf("rejoined listener receive: event=%+v error=%v", live.Event, err)
		}
	case <-ctx.Done():
		t.Fatal("rejoin did not finish after old group dropped")
	}
}

func publishTestEvent(t *testing.T, ctx context.Context, client *Client, room string, id int) {
	t.Helper()
	event := map[string]any{
		"type": "chat_created", "version": 1, "eventId": fmt.Sprintf("01ARZ3NDEKTSV4RRFFQ69G5F%02d", id),
		"room": room, "chatId": "01ARZ3NDEKTSV4RRFFQ69G5FAV", "userSeq": fmt.Sprintf("%d", id+1),
	}
	envelope := map[string]any{"epoch": "test", "streamId": fmt.Sprintf("%d-0", id+1), "event": event}
	payload, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.redis.SPublish(ctx, Channel(room), payload).Err(); err != nil {
		t.Fatal(err)
	}
}
