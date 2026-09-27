package config

import (
	"os"
	"reflect"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("WS_TICKET_SECRET") == "" {
		_ = os.Setenv("WS_TICKET_SECRET", "test-ws-ticket-secret-long-enough-for-hmac-2026")
	}
	os.Exit(m.Run())
}

func TestLoadBrokerAddresses(t *testing.T) {
	t.Setenv("RABBITMQ_URLS", "amqp://rabbitmq-1:5672/, amqp://rabbitmq-2:5672/")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"amqp://rabbitmq-1:5672/", "amqp://rabbitmq-2:5672/"}
	if !reflect.DeepEqual(c.RabbitURLs, want) {
		t.Fatalf("RabbitURLs = %v, want %v", c.RabbitURLs, want)
	}
}

func TestLoadRejectsEmptyBrokerAddress(t *testing.T) {
	t.Setenv("RABBITMQ_URLS", "amqp://rabbitmq-1:5672/,")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted an empty broker address")
	}
}

func TestLoadRejectsInvalidExplicitCapacity(t *testing.T) {
	t.Setenv("WS_QUEUE_ITEMS", "0")
	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid capacity")
	}
}

func TestLoadRejectsPingAfterPong(t *testing.T) {
	t.Setenv("WS_PING_INTERVAL", "60s")
	t.Setenv("WS_PONG_TIMEOUT", "30s")
	if _, err := Load(); err == nil {
		t.Fatal("Load() error = nil, want invalid deadlines")
	}
}

func TestLoadRejectsInvalidACKBounds(t *testing.T) {
	t.Setenv("WS_PENDING_ACK_LIMIT", "0")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted zero pending ACK limit")
	}
	t.Setenv("WS_PENDING_ACK_LIMIT", "10")
	t.Setenv("WS_ACK_TIMEOUT", "0s")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted zero ACK timeout")
	}
}

func TestLoadRequiresTicketSecret(t *testing.T) {
	t.Setenv("WS_TICKET_SECRET", "")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted an empty signing secret")
	}
}

func TestLoadHandshakeLimit(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.HandshakeRate != 30 || c.HandshakeWindow != time.Minute {
		t.Fatalf("handshake limit = %d per %s, want 30 per minute", c.HandshakeRate, c.HandshakeWindow)
	}
	t.Setenv("WS_HANDSHAKE_RATE", "0")
	if _, err := Load(); err == nil {
		t.Fatal("Load() accepted zero handshake rate")
	}
}
