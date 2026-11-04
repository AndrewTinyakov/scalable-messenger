package rabbitmq

import (
	"context"
	"errors"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	amqp "github.com/rabbitmq/amqp091-go"

	"messenger/ws/internal/messaging"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
)

func TestPublisherTransportCancellation(t *testing.T) {
	brokerURL := os.Getenv("RABBITMQ_TEST_URL")
	if brokerURL == "" {
		t.Skip("RABBITMQ_TEST_URL is not set")
	}
	command := protocol.SendCommand{Version: 1, ChatID: "01ARZ3NDEKTSV4RRFFQ69G5FAV", RequestID: "01ARZ3NDEKTSV4RRFFQ69G5FAW", SenderID: "01ARZ3NDEKTSV4RRFFQ69G5FAX", Body: "transport cancellation test", SentAt: "2026-09-30T00:00:00Z"}
	t.Run("oversized publication does not consume broker capacity", func(t *testing.T) {
		publisher, err := New([]string{brokerURL}, 1, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		oversized := command
		oversized.Body = strings.Repeat("a", 64<<10)
		if err := publisher.Publish(context.Background(), oversized); !errors.Is(err, ErrRejected) {
			t.Fatalf("oversized publish = %v, want rejected", err)
		}
		if err := publisher.Publish(context.Background(), command); err != nil {
			t.Fatalf("publication after rejection: %v", err)
		}
	})
	t.Run("mandatory returns identify the correct request among repeated request IDs", func(t *testing.T) {
		publisher, err := New([]string{brokerURL}, 32, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		registry := prometheus.NewRegistry()
		publisher.SetMetrics(monitoring.New(registry))
		for range 3 {
			if err := publisher.Publish(context.Background(), command); err != nil {
				t.Fatal(err)
			}
		}
		connection, err := amqp.Dial(brokerURL)
		if err != nil {
			t.Fatal(err)
		}
		defer connection.Close()
		channel, err := connection.Channel()
		if err != nil {
			t.Fatal(err)
		}
		rejected := command
		rejected.ChatID = "01ARZ3NDEKTSV4RRFFQ69G5FA1"
		healthy := command
		healthy.ChatID = "01ARZ3NDEKTSV4RRFFQ69G5FA2"
		route := messaging.Route(rejected.ChatID)
		if err := channel.QueueUnbind(route, route, messaging.Exchange, nil); err != nil {
			t.Fatal(err)
		}
		defer func() {
			if err := channel.QueueBind(route, route, messaging.Exchange, false, nil); err != nil {
				t.Error(err)
			}
		}()
		type outcome struct {
			rejected bool
			err      error
		}
		results := make(chan outcome, 32)
		for range 16 {
			go func() { results <- outcome{true, publisher.Publish(context.Background(), rejected)} }()
			go func() { results <- outcome{false, publisher.Publish(context.Background(), healthy)} }()
		}
		for range 32 {
			result := <-results
			if result.rejected && !errors.Is(result.err, ErrRejected) {
				t.Errorf("unroutable request = %v", result.err)
			} else if !result.rejected && result.err != nil {
				t.Errorf("routable request = %v", result.err)
			}
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 19)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "rejected", 16)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "unknown", 0)
	})
	t.Run("startup tries another broker after a stalled handshake", func(t *testing.T) {
		listener, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		defer listener.Close()
		done := make(chan struct{})
		go func() {
			defer close(done)
			conn, err := listener.Accept()
			if err != nil {
				return
			}
			defer conn.Close()
			_, _ = io.Copy(io.Discard, conn)
		}()
		publisher, err := New([]string{"amqp://guest:guest@" + listener.Addr().String() + "/", brokerURL}, 1, 2*time.Second)
		<-done
		if err != nil {
			t.Fatalf("startup did not try available broker: %v", err)
		}
		defer publisher.Close()
		if err := publisher.Publish(context.Background(), command); err != nil {
			t.Fatalf("fallback broker publish: %v", err)
		}
	})
	t.Run("sequential publishes reuse an existing transport", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 4, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		registry := prometheus.NewRegistry()
		publisher.SetMetrics(monitoring.New(registry))
		for range 8 {
			if err := publisher.Publish(context.Background(), command); err != nil {
				t.Fatal(err)
			}
		}
		if count := faults.accepted.Load(); count > 3 {
			t.Fatalf("sequential publishes opened %d transports", count)
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_capacity_wait_seconds", "ready", 8)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_queue_wait_seconds", "ready", 8)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_channel_acquisition_seconds", "ready", 2)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 8)
	})
	t.Run("concurrent publishes share a bounded connection pool", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 32, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		faults.dropFirst.Store(true)
		results := make(chan error, 32)
		start := make(chan struct{})
		for range 32 {
			go func() {
				<-start
				results <- publisher.Publish(context.Background(), command)
			}()
		}
		close(start)
		confirmed := 0
		for range 32 {
			if err := <-results; err == nil {
				confirmed++
			} else if !errors.Is(err, ErrUnknownOutcome) {
				t.Errorf("publish result = %v", err)
			}
		}
		if confirmed == 0 {
			t.Fatal("available connections confirmed no requests")
		}
		if count := faults.accepted.Load(); count > 3 {
			t.Fatalf("concurrent publishes opened %d transports, want at most 3", count)
		}
	})
	t.Run("cancelled confirmation preserves requests sharing its transport", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 4, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		faults.holdFirst.Store(true)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()
		result := make(chan error, 1)
		go func() { result <- publisher.Publish(ctx, command) }()
		<-faults.dropped
		for range 2 {
			if err := publisher.Publish(context.Background(), command); err != nil {
				t.Fatalf("available transport publish: %v", err)
			}
		}
		shared := make(chan error, 1)
		go func() { shared <- publisher.Publish(context.Background(), command) }()
		started := time.Now()
		cancel()
		select {
		case err := <-result:
			if !errors.Is(err, ErrUnknownOutcome) || !errors.Is(err, context.Canceled) {
				t.Fatalf("cancelled confirmation = %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("confirmation cancellation did not interrupt transport")
		}
		if time.Since(started) > time.Second {
			t.Fatal("confirmation cancellation did not interrupt transport")
		}
		close(faults.resume)
		select {
		case err := <-shared:
			if err != nil {
				t.Fatalf("shared transport publish: %v", err)
			}
		case <-time.After(time.Second):
			t.Fatal("shared transport did not remain usable")
		}
		if count := faults.accepted.Load(); count > 3 {
			t.Fatalf("shared requests opened %d transports", count)
		}

	})
	t.Run("queued expiry is separate from channel acquisition and confirmation", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 5, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		registry := prometheus.NewRegistry()
		publisher.SetMetrics(monitoring.New(registry))
		faults.blockNew.Store(true)
		if err := publisher.Publish(context.Background(), command); err != nil {
			t.Fatal(err)
		}
		for range 2 {
			ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
			err := publisher.Publish(ctx, command)
			cancel()
			if !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrUnknownOutcome) {
				t.Fatalf("publication acquiring channel = %v", err)
			}
		}
		if err := publisher.Publish(context.Background(), command); err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
		defer cancel()
		if err := publisher.Publish(ctx, command); !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrUnknownOutcome) {
			t.Fatalf("publication queued behind channel acquisition = %v", err)
		}
		publisher.Close()
		wait := assertPublishMetricCount(t, registry, "messenger_ws_publish_queue_wait_seconds", "failed", 1)
		if wait < 30*time.Millisecond || wait > time.Second {
			t.Fatalf("expired queue duration = %s", wait)
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_capacity_wait_seconds", "ready", 5)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_queue_wait_seconds", "ready", 4)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_channel_acquisition_seconds", "failed", 2)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 2)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "unknown", 0)
	})
	t.Run("deadline interrupts connection setup", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 2, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		registry := prometheus.NewRegistry()
		publisher.SetMetrics(monitoring.New(registry))
		faults.dropFirst.Store(true)
		activeCtx, cancelActive := context.WithCancel(context.Background())
		defer cancelActive()
		result := make(chan error, 1)
		go func() { result <- publisher.Publish(activeCtx, command) }()
		<-faults.dropped
		faults.blockNew.Store(true)
		ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
		defer cancel()
		started := time.Now()
		err = publisher.Publish(ctx, command)
		if !errors.Is(err, context.DeadlineExceeded) {
			t.Fatalf("cancelled setup = %v", err)
		}
		if time.Since(started) > time.Second {
			t.Fatal("setup exceeded the caller deadline")
		}
		cancelActive()
		<-result
		publisher.Close()
		acquisition := assertPublishMetricCount(t, registry, "messenger_ws_publish_channel_acquisition_seconds", "failed", 1)
		if acquisition < 40*time.Millisecond || acquisition > time.Second {
			t.Fatalf("failed channel acquisition duration = %s", acquisition)
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_queue_wait_seconds", "ready", 2)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "unknown", 1)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 0)
	})
	t.Run("cancelled callers retain their outstanding publication budget", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 1, 2*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		registry := prometheus.NewRegistry()
		publisher.SetMetrics(monitoring.New(registry))
		faults.holdFirst.Store(true)
		ctx, cancel := context.WithCancel(context.Background())
		result := make(chan error, 1)
		go func() { result <- publisher.Publish(ctx, command) }()
		<-faults.dropped
		cancel()
		if err := <-result; !errors.Is(err, ErrUnknownOutcome) {
			t.Fatalf("cancelled outstanding publication = %v", err)
		}
		waiting, stop := context.WithTimeout(context.Background(), 40*time.Millisecond)
		defer stop()
		if err := publisher.Publish(waiting, command); !errors.Is(err, context.DeadlineExceeded) || errors.Is(err, ErrUnknownOutcome) {
			t.Fatalf("publication over outstanding budget = %v", err)
		}
		wait := assertPublishMetricCount(t, registry, "messenger_ws_publish_capacity_wait_seconds", "failed", 1)
		if wait < 30*time.Millisecond || wait > time.Second {
			t.Fatalf("capacity wait duration = %s", wait)
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_queue_wait_seconds", "ready", 1)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 0)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "unknown", 0)
		close(faults.resume)
		if err := publisher.Publish(context.Background(), command); err != nil {
			t.Fatalf("publication after retained confirmation: %v", err)
		}
		if count := faults.accepted.Load(); count != 1 {
			t.Fatalf("cancellation opened %d transports", count)
		}
		confirmation := assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 2)
		if confirmation < wait || confirmation > 2*time.Second {
			t.Fatalf("confirmation duration = %s, retained wait = %s", confirmation, wait)
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_capacity_wait_seconds", "ready", 2)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_queue_wait_seconds", "ready", 2)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_channel_acquisition_seconds", "ready", 0)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "unknown", 0)
	})
	t.Run("shutdown joins active and waiting publishes", func(t *testing.T) {
		proxyURL, faults := brokerProxy(t, brokerURL)
		publisher, err := New([]string{proxyURL}, 1, 10*time.Second)
		if err != nil {
			t.Fatal(err)
		}
		defer publisher.Close()
		registry := prometheus.NewRegistry()
		publisher.SetMetrics(monitoring.New(registry))
		faults.dropFirst.Store(true)
		results := make(chan error, 2)
		started := make(chan struct{}, 2)
		for range 2 {
			go func() {
				started <- struct{}{}
				results <- publisher.Publish(context.Background(), command)
			}()
		}
		<-started
		<-started
		<-faults.dropped
		closed := make(chan struct{})
		go func() { _ = publisher.Close(); close(closed) }()
		select {
		case <-closed:
		case <-time.After(time.Second):
			t.Fatal("shutdown did not join publishes")
		}
		for range 2 {
			select {
			case err := <-results:
				if err == nil {
					t.Fatal("publish succeeded without a confirmation")
				}
			case <-time.After(time.Second):
				t.Fatal("publish remained blocked after shutdown")
			}
		}
		if err := publisher.Publish(context.Background(), command); !errors.Is(err, ErrClosed) {
			t.Fatalf("publish after shutdown = %v", err)
		}
		assertPublishMetricCount(t, registry, "messenger_ws_publish_capacity_wait_seconds", "failed", 1)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "unknown", 1)
		assertPublishMetricCount(t, registry, "messenger_ws_publish_confirmation_seconds", "confirmed", 0)
	})
}

func assertPublishMetricCount(t *testing.T, registry *prometheus.Registry, name, result string, expected uint64) time.Duration {
	t.Helper()
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	var count uint64
	var seconds float64
	for _, family := range families {
		if family.GetName() != name {
			continue
		}
		for _, metric := range family.Metric {
			if len(metric.Label) != 1 || metric.Label[0].GetName() != "result" || metric.Histogram == nil {
				t.Fatalf("unexpected metric shape for %s: %v", name, metric)
			}
			if metric.Label[0].GetValue() == result {
				count += metric.Histogram.GetSampleCount()
				seconds += metric.Histogram.GetSampleSum()
			}
		}
	}
	if count != expected {
		t.Fatalf("%s{result=%q} count = %d, want %d", name, result, count, expected)
	}
	return time.Duration(seconds * float64(time.Second))
}
