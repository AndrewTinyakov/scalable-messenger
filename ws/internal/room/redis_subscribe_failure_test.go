package room

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"net/url"
	"os"
	"path/filepath"
	"syscall"
	"testing"
	"time"

	"messenger/ws/internal/redisroom"
)

func TestFailedRedisSubscriptionDoesNotCrashRoomListener(t *testing.T) {
	dir, err := os.MkdirTemp("/tmp", "ws-redis-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Remove(dir) })

	missingSocket := (&url.URL{
		Scheme: "unix",
		Path:   filepath.Join(dir, "unavailable.sock"),
	}).String()
	client, err := redisroom.New(missingSocket, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })

	logger := slog.New(slog.NewTextHandler(io.Discard, nil))
	rooms := newRooms(redisRoomStore{client: client}, logger, 8, 8, 4096, time.Second, nil)
	entry := &localRoom{name: "user:01ARZ3NDEKTSV4RRFFQ69G5FA1", ready: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	returned := make(chan struct{})
	rooms.wg.Add(1)
	go func() {
		rooms.listen(ctx, entry)
		close(returned)
	}()

	select {
	case <-returned:
	case <-ctx.Done():
		t.Fatal("room listener did not return after Redis dial failed")
	}
	select {
	case <-entry.ready:
	default:
		t.Fatal("room listener did not signal readiness")
	}
	if !errors.Is(entry.err, syscall.ENOENT) {
		t.Fatalf("room error = %v, want a dial error for the missing Redis socket", entry.err)
	}
}
