package redisroom

import (
	"context"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSubscribeLimitSharedAcrossClients(t *testing.T) {
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	userID := fmt.Sprintf("subscribe-test-%d", time.Now().UnixNano())
	for i := range 10 {
		client := first
		if i%2 == 1 {
			client = second
		}
		allowed, err := client.AllowSubscribe(ctx, userID, 10, time.Second)
		if err != nil || !allowed {
			t.Fatalf("attempt %d = %v, %v; want allowed", i+1, allowed, err)
		}
	}
	if allowed, err := second.AllowSubscribe(ctx, userID, 10, time.Second); err != nil || allowed {
		t.Fatalf("eleventh attempt = %v, %v; want limited", allowed, err)
	}
	if allowed, err := first.AllowSubscribe(ctx, userID+"-other", 10, time.Second); err != nil || !allowed {
		t.Fatalf("other user's first attempt = %v, %v; want allowed", allowed, err)
	}
	batchUser := userID + "-batch"
	if allowed, err := first.AllowSubscribeBatch(ctx, batchUser, 7, 10, 10*time.Second); err != nil || !allowed {
		t.Fatalf("seven-chat batch = %v, %v; want allowed", allowed, err)
	}
	if allowed, err := second.AllowSubscribeBatch(ctx, batchUser, 4, 10, 10*time.Second); err != nil || allowed {
		t.Fatalf("four-chat batch after seven = %v, %v; want limited", allowed, err)
	}
	if allowed, err := second.AllowSubscribeBatch(ctx, batchUser, 3, 10, 10*time.Second); err != nil || !allowed {
		t.Fatalf("three-chat batch after denied batch = %v, %v; want allowed", allowed, err)
	}
}

func TestHandshakeLimitSharedAcrossClientsAndIndependentOfSubscribe(t *testing.T) {
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	userID := fmt.Sprintf("handshake-test-%d", time.Now().UnixNano())
	for i := range 3 {
		client := first
		if i%2 == 1 {
			client = second
		}
		allowed, err := client.AllowHandshake(ctx, userID, 3, time.Second)
		if err != nil || !allowed {
			t.Fatalf("handshake %d = %v, %v; want allowed", i+1, allowed, err)
		}
	}
	if allowed, err := second.AllowHandshake(ctx, userID, 3, time.Second); err != nil || allowed {
		t.Fatalf("fourth handshake = %v, %v; want limited", allowed, err)
	}
	if allowed, err := first.AllowSubscribe(ctx, userID, 3, time.Second); err != nil || !allowed {
		t.Fatalf("subscription after handshake limit = %v, %v; want allowed", allowed, err)
	}
	if allowed, err := first.AllowHandshake(ctx, userID+"-other", 3, time.Second); err != nil || !allowed {
		t.Fatalf("other user's first handshake = %v, %v; want allowed", allowed, err)
	}
}

func connectionTestClients(t *testing.T) (*Client, *Client) {
	t.Helper()
	url := os.Getenv("REDIS_TEST_URL")
	cluster := os.Getenv("REDIS_TEST_CLUSTER_NODES")
	if url == "" && cluster == "" {
		t.Skip("set REDIS_TEST_URL or REDIS_TEST_CLUSTER_NODES to run against Redis")
	}
	var nodes []string
	if cluster != "" {
		nodes = strings.Split(cluster, ",")
	}
	first, err := New(url, nodes)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = first.Close() })
	second, err := New(url, nodes)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = second.Close() })
	return first, second
}
