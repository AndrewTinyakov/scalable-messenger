package redisroom

import (
	"context"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestConnectionKeysUseOneClusterHashTag(t *testing.T) {
	userID := "user:{unexpected}:value"
	leaseKey := connectionLeaseKey(userID)
	limitKey := subscribeLimitKey(userID)
	handshakeKey := handshakeLimitKey(userID)
	if strings.Contains(leaseKey, userID) || strings.Contains(limitKey, userID) || strings.Contains(handshakeKey, userID) {
		t.Fatal("user ID appeared in a Redis key")
	}
	if strings.TrimSuffix(leaseKey, ":leases") != strings.TrimSuffix(limitKey, ":subscribe") {
		t.Fatalf("per-user keys do not share a Redis Cluster hash tag: %q, %q", leaseKey, limitKey)
	}
	if strings.TrimSuffix(leaseKey, ":leases") != strings.TrimSuffix(handshakeKey, ":handshake") {
		t.Fatalf("handshake key does not share the per-user hash tag: %q, %q", leaseKey, handshakeKey)
	}
	if handshakeKey == limitKey {
		t.Fatal("handshake and subscribe limits share a Redis key")
	}
	if connectionLeaseKey(userID) == connectionLeaseKey("another-user") {
		t.Fatal("different users got the same connection key")
	}
}

func TestConnectionLeaseInputValidation(t *testing.T) {
	client := &Client{}
	if _, _, err := client.AcquireConnectionLease(context.Background(), ""); err == nil {
		t.Fatal("empty user ID was accepted")
	}
	if _, err := client.RenewConnectionLease(context.Background(), "user", ""); err == nil {
		t.Fatal("empty lease ID was accepted")
	}
	if err := client.ReleaseConnectionLease(context.Background(), "user", ""); err == nil {
		t.Fatal("empty lease ID was accepted")
	}
	for _, tc := range []struct {
		limit  int
		window time.Duration
	}{
		{0, time.Second},
		{10, 0},
		{10, time.Microsecond},
	} {
		if _, err := client.AllowSubscribe(context.Background(), "user", tc.limit, tc.window); err == nil {
			t.Fatalf("invalid subscribe limit %d/%s was accepted", tc.limit, tc.window)
		}
		if _, err := client.AllowHandshake(context.Background(), "user", tc.limit, tc.window); err == nil {
			t.Fatalf("invalid handshake limit %d/%s was accepted", tc.limit, tc.window)
		}
	}
	if _, err := client.AllowSubscribeBatch(context.Background(), "user", 0, 10, time.Second); err == nil {
		t.Fatal("empty subscribe batch was accepted")
	}
	if _, err := client.AllowSubscribeBatch(context.Background(), "user", 11, 10, time.Second); err == nil {
		t.Fatal("subscribe batch larger than burst was accepted")
	}
}

func TestConnectionLeaseAtomicAdmissionAndCleanup(t *testing.T) {
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	userID := fmt.Sprintf("lease-test-%d", time.Now().UnixNano())
	var wg sync.WaitGroup
	results := make(chan struct {
		leaseID string
		allowed bool
		err     error
	}, 2*MaxConnectionsPerUser)
	for i := range 2 * MaxConnectionsPerUser {
		wg.Add(1)
		client := first
		if i%2 == 1 {
			client = second
		}
		go func() {
			defer wg.Done()
			leaseID, allowed, err := client.AcquireConnectionLease(ctx, userID)
			results <- struct {
				leaseID string
				allowed bool
				err     error
			}{leaseID, allowed, err}
		}()
	}
	wg.Wait()
	close(results)
	var leases []string
	for result := range results {
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.allowed {
			leases = append(leases, result.leaseID)
		}
	}
	if got := len(leases); got != MaxConnectionsPerUser {
		t.Fatalf("accepted leases = %d, want %d", got, MaxConnectionsPerUser)
	}
	for _, leaseID := range leases {
		defer func(id string) { _ = first.ReleaseConnectionLease(ctx, userID, id) }(leaseID)
	}
	if renewed, err := second.RenewConnectionLease(ctx, userID, leases[0]); err != nil || !renewed {
		t.Fatalf("renew active lease = %v, %v", renewed, err)
	}
	if err := first.ReleaseConnectionLease(ctx, userID, leases[0]); err != nil {
		t.Fatal(err)
	}
	if renewed, err := second.RenewConnectionLease(ctx, userID, leases[0]); err != nil || renewed {
		t.Fatalf("renew released lease = %v, %v; want false", renewed, err)
	}
	if _, allowed, err := second.AcquireConnectionLease(ctx, userID); err != nil || !allowed {
		t.Fatalf("acquire freed slot = %v, %v; want allowed", allowed, err)
	}
}

func TestConnectionLeaseExpiresAfterCrash(t *testing.T) {
	client, _ := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	userID := fmt.Sprintf("expired-lease-test-%d", time.Now().UnixNano())
	leaseID := "crashed-node-lease"
	if got, err := acquireConnectionScript.Run(ctx, client.redis, []string{connectionLeaseKey(userID)}, 40, 1, leaseID).Int64(); err != nil || got != 1 {
		t.Fatalf("acquire short lease = %d, %v", got, err)
	}
	deadline := time.Now().Add(time.Second)
	for {
		if got, err := acquireConnectionScript.Run(ctx, client.redis, []string{connectionLeaseKey(userID)}, 40, 1, "replacement").Int64(); err != nil {
			t.Fatal(err)
		} else if got == 1 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("crashed connection lease did not expire")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if renewed, err := client.RenewConnectionLease(ctx, userID, leaseID); err != nil || renewed {
		t.Fatalf("renew expired lease = %v, %v; want false", renewed, err)
	}
}

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
