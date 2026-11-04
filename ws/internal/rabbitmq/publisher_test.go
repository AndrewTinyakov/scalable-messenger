package rabbitmq

import (
	"net"
	"testing"
	"time"
)

func TestPublisherRejectsInvalidConfiguration(t *testing.T) {
	for _, configuration := range []struct {
		urls        []string
		concurrency int
		timeout     time.Duration
	}{
		{nil, 1, time.Second},
		{[]string{"amqp://localhost/"}, 0, time.Second},
		{[]string{"amqp://localhost/"}, 1, 0},
	} {
		publisher, err := New(configuration.urls, configuration.concurrency, configuration.timeout)
		if publisher != nil || err == nil {
			t.Fatalf("invalid configuration accepted: publisher=%v error=%v", publisher, err)
		}
	}
}

func TestStartupBoundsUnresponsiveBrokerHandshake(t *testing.T) {
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
		time.Sleep(250 * time.Millisecond)
	}()
	started := time.Now()
	publisher, err := New([]string{"amqp://guest:guest@" + listener.Addr().String() + "/"}, 1, 40*time.Millisecond)
	elapsed := time.Since(started)
	if publisher != nil {
		publisher.Close()
	}
	<-done
	if err == nil {
		t.Fatal("unresponsive broker was accepted")
	}
	if elapsed > 200*time.Millisecond {
		t.Fatalf("startup waited %s for a 40ms timeout", elapsed)
	}
}
