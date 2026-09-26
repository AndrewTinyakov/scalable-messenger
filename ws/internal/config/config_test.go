package config

import "testing"

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
