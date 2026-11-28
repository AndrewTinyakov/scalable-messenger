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

func TestLoadRejectsInvalidAllowedOrigins(t *testing.T) {
	for _, origin := range []string{"", "*", "null", "https://*.example", "https://example.com/", "https://example.com/path", "https://example.com?x=1", "https://example.com?", "https://example.com#", "https://example.com#fragment", "https://user@example.com", "wss://example.com", "HTTPS://example.com", "https://EXAMPLE.com", "https://example.com:443", "http://example.com:80", "http://example.com:080", "http://example.com:0", "http://example.com:65536", "https://example.com:", "https://[dead:beef]", "https://example.com https://other.example"} {
		t.Run(origin, func(t *testing.T) {
			t.Setenv("WS_ALLOWED_ORIGIN", origin)
			if _, err := Load(); err == nil {
				t.Fatalf("Load() accepted invalid origin %q", origin)
			}
		})
	}
}

func TestLoadCanonicalAllowedOrigins(t *testing.T) {
	for _, origin := range []string{"https://example.com", "http://localhost:8080", "http://127.0.0.1:8080", "https://[::1]:8443", "https://xn--bcher-kva.example"} {
		t.Run(origin, func(t *testing.T) {
			t.Setenv("WS_ALLOWED_ORIGIN", origin)
			loaded, err := Load()
			if err != nil || loaded.AllowedOrigin != origin {
				t.Fatalf("Load() = %v, %v, want origin %q", loaded, err, origin)
			}
		})
	}
}

func TestLoadRejectsUnboundedWorkAndInvalidDrain(t *testing.T) {
	for _, name := range []string{"WS_MAX_ROOMS", "WS_MAX_MEMBERSHIPS", "WS_COMMAND_WORKERS", "WS_COMMAND_QUEUE_ITEMS", "WS_COMMAND_QUEUE_BYTES", "WS_CONNECTION_COMMAND_ITEMS", "WS_CONNECTION_COMMAND_BYTES"} {
		t.Run(name, func(t *testing.T) {
			t.Setenv(name, "0")
			if _, err := Load(); err == nil {
				t.Fatalf("accepted zero %s", name)
			}
		})
	}
	t.Setenv("WS_DRAIN_TIMEOUT", "10s")
	t.Setenv("WS_SHUTDOWN_TIMEOUT", "10s")
	if _, err := Load(); err == nil {
		t.Fatal("accepted drain without remaining shutdown time")
	}
	t.Setenv("WS_DRAIN_TIMEOUT", "0s")
	if _, err := Load(); err != nil {
		t.Fatalf("zero drain should disable staggering: %v", err)
	}
}

func TestLoadGRPCDefaults(t *testing.T) {
	for _, key := range []string{"API_GRPC_ADDRESS", "API_GRPC_CA_FILE", "API_GRPC_CERT_FILE", "API_GRPC_KEY_FILE", "API_GRPC_SERVER_NAME"} {
		value, present := os.LookupEnv(key)
		_ = os.Unsetenv(key)
		t.Cleanup(func() {
			if present {
				_ = os.Setenv(key, value)
			} else {
				_ = os.Unsetenv(key)
			}
		})
	}
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.APIGrpcAddress != "dns:///api-grpc:9090" || c.APIGrpcCAFile != "/run/messenger-grpc/ca.pem" || c.APIGrpcCertFile != "/run/messenger-grpc/ws-cert.pem" || c.APIGrpcKeyFile != "/run/messenger-grpc/ws-key.pem" || c.APIGrpcServerName != "api-grpc" {
		t.Fatalf("gRPC defaults = %q, %q, %q, %q, %q", c.APIGrpcAddress, c.APIGrpcCAFile, c.APIGrpcCertFile, c.APIGrpcKeyFile, c.APIGrpcServerName)
	}
}

func TestLoadGRPCTLSOverrides(t *testing.T) {
	t.Setenv("API_GRPC_ADDRESS", "dns:///custom-api:9090")
	t.Setenv("API_GRPC_CA_FILE", "/custom/ca.pem")
	t.Setenv("API_GRPC_CERT_FILE", "/custom/cert.pem")
	t.Setenv("API_GRPC_KEY_FILE", "/custom/key.pem")
	t.Setenv("API_GRPC_SERVER_NAME", "custom-api")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.APIGrpcAddress != "dns:///custom-api:9090" || c.APIGrpcCAFile != "/custom/ca.pem" || c.APIGrpcCertFile != "/custom/cert.pem" || c.APIGrpcKeyFile != "/custom/key.pem" || c.APIGrpcServerName != "custom-api" {
		t.Fatalf("gRPC configuration = %q, %q, %q, %q, %q", c.APIGrpcAddress, c.APIGrpcCAFile, c.APIGrpcCertFile, c.APIGrpcKeyFile, c.APIGrpcServerName)
	}
}

func TestLoadProfilingPort(t *testing.T) {
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.ProfilingPort != 0 {
		t.Fatalf("ProfilingPort = %d, want disabled by default", c.ProfilingPort)
	}
	t.Setenv("WS_PPROF_PORT", "6060")
	if c, err = Load(); err != nil || c.ProfilingPort != 6060 {
		t.Fatalf("ProfilingPort = %d, %v, want 6060", c.ProfilingPort, err)
	}
	for _, invalid := range []string{"-1", "65536", "port"} {
		t.Setenv("WS_PPROF_PORT", invalid)
		if _, err := Load(); err == nil {
			t.Fatalf("Load() accepted WS_PPROF_PORT=%q", invalid)
		}
	}
}
