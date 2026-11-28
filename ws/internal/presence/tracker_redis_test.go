package presence

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"strings"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/redisroom"
)

func TestRemoveGatewayClearsOnlyThatGatewayInRedis(t *testing.T) {
	url, cluster := os.Getenv("REDIS_TEST_URL"), os.Getenv("REDIS_TEST_CLUSTER_NODES")
	if url == "" && cluster == "" {
		t.Skip("set REDIS_TEST_URL or REDIS_TEST_CLUSTER_NODES to run against Redis")
	}
	var nodes []string
	if cluster != "" {
		nodes = strings.Split(cluster, ",")
	}
	client, err := redisroom.New(url, nodes)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	run := time.Now().UnixNano()
	stopping, surviving := fmt.Sprintf("stopping-%d", run), fmt.Sprintf("surviving-%d", run)
	onlyStopping, shared := user(int(run%1e12)), user(int(run%1e12)+1)
	store := RedisStore(client)
	t.Cleanup(func() {
		store.SetPresence(context.Background(), surviving, map[string]bool{shared: false})
		_ = store.ForgetPresenceGateway(context.Background(), surviving)
		_ = client.ForgetGateway(context.Background(), stopping)
	})
	if _, _, err := client.Heartbeat(ctx, stopping, time.Minute); err != nil {
		t.Fatal(err)
	}
	if failed := store.SetPresence(ctx, stopping, map[string]bool{onlyStopping: true, shared: true}); len(failed) > 0 {
		t.Fatal(failed)
	}
	if failed := store.SetPresence(ctx, surviving, map[string]bool{shared: true}); len(failed) > 0 {
		t.Fatal(failed)
	}
	tracker := NewTracker(store, recorderFunc(func(context.Context, []grpcauth.LastSeen) error { return nil }), func() string { return stopping }, testConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err := tracker.RemoveGateway(ctx, stopping); err != nil {
		t.Fatal(err)
	}
	states, _, err := store.PresenceSnapshot(ctx, []string{onlyStopping, shared})
	if err != nil {
		t.Fatal(err)
	}
	if states[onlyStopping].Online || !states[shared].Online {
		t.Fatalf("after clearing %s: only-stopping online = %v, shared online = %v; want false, true", stopping, states[onlyStopping].Online, states[shared].Online)
	}
	if users, _, err := store.PresenceGatewayUsers(ctx, stopping, 0); err != nil || len(users) != 0 {
		t.Fatalf("presence index of the stopped gateway = %v, %v; want empty", users, err)
	}
	if registered, dead, err := client.Heartbeat(ctx, stopping, time.Minute); err != nil || !registered || dead {
		t.Fatalf("fleet registration after clearing presence = registered %v, dead %v, %v; want kept for peer reaping", registered, dead, err)
	}
}
