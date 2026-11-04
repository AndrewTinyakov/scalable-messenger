package redisroom

import (
	"context"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func presenceClients(t *testing.T) (*Client, *Client, context.Context, string) {
	t.Helper()
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	t.Cleanup(cancel)
	user := fmt.Sprintf("presence-%s-%d", t.Name(), time.Now().UnixNano())
	t.Cleanup(func() {
		cleanup, stop := context.WithTimeout(context.Background(), time.Second)
		defer stop()
		_ = first.redis.Del(cleanup, connectionLeaseKey(user), connectionOnlineKey(user), connectionUserKey(user, "presence"), subscribeLimitKey(user), handshakeLimitKey(user)).Err()
	})
	return first, second, ctx, user
}

func assertPresence(t *testing.T, client *Client, ctx context.Context, user string, online bool) {
	t.Helper()
	states, err := client.Presence(ctx, []string{user})
	if err != nil || len(states) != 1 || states[user] != online {
		t.Fatalf("presence = %v, %v; want %s online=%v", states, err, user, online)
	}
}

func acquirePresenceLease(t *testing.T, client *Client, ctx context.Context, user string) string {
	t.Helper()
	lease, allowed, err := client.AcquireConnectionLease(ctx, user)
	if err != nil || !allowed || lease == "" {
		t.Fatalf("acquire = %q, %v, %v", lease, allowed, err)
	}
	return lease
}

func establishPresenceLease(t *testing.T, client *Client, ctx context.Context, user, lease string) {
	t.Helper()
	if active, err := client.EstablishConnectionLease(ctx, user, lease); err != nil || !active {
		t.Fatalf("establish = %v, %v", active, err)
	}
}

func TestPresenceReservationIsOfflineUntilSocketEstablished(t *testing.T) {
	first, second, ctx, user := presenceClients(t)
	lease := acquirePresenceLease(t, first, ctx, user)
	assertPresence(t, second, ctx, user, false)
	if active, err := first.RenewConnectionLease(ctx, user, lease); err != nil || !active {
		t.Fatalf("renew reservation = %v, %v", active, err)
	}
	assertPresence(t, second, ctx, user, false)
	establishPresenceLease(t, first, ctx, user, lease)
	assertPresence(t, second, ctx, user, true)
}

func TestPresenceAllDevicesMustCloseBeforeUserIsOffline(t *testing.T) {
	first, second, ctx, user := presenceClients(t)
	a := acquirePresenceLease(t, first, ctx, user)
	b := acquirePresenceLease(t, second, ctx, user)
	establishPresenceLease(t, first, ctx, user, a)
	establishPresenceLease(t, second, ctx, user, b)
	if err := first.ReleaseConnectionLease(ctx, user, a); err != nil {
		t.Fatal(err)
	}
	assertPresence(t, second, ctx, user, true)
	if err := second.ReleaseConnectionLease(ctx, user, b); err != nil {
		t.Fatal(err)
	}
	assertPresence(t, first, ctx, user, false)
	if active, err := first.RenewConnectionLease(ctx, user, b); err != nil || active {
		t.Fatalf("released lease renewed = %v, %v", active, err)
	}
	if active, err := first.EstablishConnectionLease(ctx, user, b); err != nil || active {
		t.Fatalf("released lease established = %v, %v", active, err)
	}
	assertPresence(t, first, ctx, user, false)
}

func TestPresenceIgnoresExpiredScoresBeforeRedisKeyCleanup(t *testing.T) {
	first, second, ctx, user := presenceClients(t)
	lease := acquirePresenceLease(t, first, ctx, user)
	establishPresenceLease(t, first, ctx, user, lease)
	now, err := first.redis.Time(ctx).Result()
	if err != nil {
		t.Fatal(err)
	}
	if err := first.redis.ZAdd(ctx, connectionOnlineKey(user), redis.Z{Score: float64(now.Add(-time.Millisecond).UnixMilli()), Member: lease}).Err(); err != nil {
		t.Fatal(err)
	}
	assertPresence(t, second, ctx, user, false)
	if count, err := first.redis.ZCard(ctx, connectionOnlineKey(user)).Result(); err != nil || count != 1 {
		t.Fatalf("stale score fixture = %d, %v", count, err)
	}
}

func TestPresenceRenewExtendsEstablishedLeaseWithoutPromotingReservations(t *testing.T) {
	for _, batch := range []bool{false, true} {
		t.Run(fmt.Sprintf("batch=%v", batch), func(t *testing.T) {
			first, second, ctx, user := presenceClients(t)
			established := acquirePresenceLease(t, first, ctx, user)
			reserved := acquirePresenceLease(t, first, ctx, user)
			establishPresenceLease(t, first, ctx, user, established)
			now, err := first.redis.Time(ctx).Result()
			if err != nil {
				t.Fatal(err)
			}
			shortExpiry := now.Add(time.Second).UnixMilli()
			if err := first.redis.ZAdd(ctx, connectionOnlineKey(user), redis.Z{Score: float64(shortExpiry), Member: established}).Err(); err != nil {
				t.Fatal(err)
			}
			if batch {
				results := first.RenewConnectionLeases(ctx, []ConnectionLease{{UserID: user, LeaseID: established}, {UserID: user, LeaseID: reserved}})
				if len(results) != 2 {
					t.Fatalf("renew results = %+v", results)
				}
				for _, result := range results {
					if !result.Active || result.Err != nil {
						t.Fatalf("renew result = %+v", result)
					}
				}
			} else {
				for _, lease := range []string{established, reserved} {
					if active, err := first.RenewConnectionLease(ctx, user, lease); err != nil || !active {
						t.Fatalf("renew = %v, %v", active, err)
					}
				}
			}
			score, err := first.redis.ZScore(ctx, connectionOnlineKey(user), established).Result()
			if err != nil || score < float64(now.Add(ConnectionLeaseTTL-time.Second).UnixMilli()) {
				t.Fatalf("renewed online expiry = %v, %v; initial short expiry=%d", score, err, shortExpiry)
			}
			if _, err := first.redis.ZScore(ctx, connectionOnlineKey(user), reserved).Result(); err != redis.Nil {
				t.Fatalf("reservation promoted by renewal: %v", err)
			}
			assertPresence(t, second, ctx, user, true)
		})
	}
}

func TestPresenceCannotPromoteExpiredOrMissingReservation(t *testing.T) {
	first, second, ctx, user := presenceClients(t)
	lease := acquirePresenceLease(t, first, ctx, user)
	now, err := first.redis.Time(ctx).Result()
	if err != nil {
		t.Fatal(err)
	}
	if err := first.redis.ZAdd(ctx, connectionLeaseKey(user), redis.Z{Score: float64(now.Add(-time.Millisecond).UnixMilli()), Member: lease}).Err(); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{lease, "missing"} {
		if active, err := first.EstablishConnectionLease(ctx, user, id); err != nil || active {
			t.Fatalf("expired/missing promotion = %v, %v", active, err)
		}
	}
	assertPresence(t, second, ctx, user, false)
}

func TestPresenceSnapshotsBoundAndValidateTargets(t *testing.T) {
	first, _, ctx, _ := presenceClients(t)
	for _, ids := range [][]string{nil, {}, make([]string, 101), {""}, {strings.Repeat("x", 257)}} {
		if _, err := first.Presence(ctx, ids); err == nil {
			t.Fatalf("accepted invalid targets len=%d", len(ids))
		}
	}
	ids := make([]string, 100)
	for i := range ids {
		ids[i] = fmt.Sprintf("presence-missing-%d", i)
	}
	states, err := first.Presence(ctx, ids)
	if err != nil || len(states) != 100 {
		t.Fatalf("maximum snapshot = %v, %v", states, err)
	}
	for _, online := range states {
		if online {
			t.Fatal("unknown lease appeared online")
		}
	}
}

func TestPresenceRateLimitIsSharedAndIndependentOfOtherOperations(t *testing.T) {
	first, second, ctx, user := presenceClients(t)
	for i := range 10 {
		client := first
		if i%2 == 1 {
			client = second
		}
		if allowed, err := client.AllowPresenceWatch(ctx, user); err != nil || !allowed {
			t.Fatalf("presence attempt %d = %v, %v", i+1, allowed, err)
		}
	}
	if allowed, err := second.AllowPresenceWatch(ctx, user); err != nil || allowed {
		t.Fatalf("presence burst overflow = %v, %v", allowed, err)
	}
	if allowed, err := first.AllowSubscribe(ctx, user, 1, time.Minute); err != nil || !allowed {
		t.Fatalf("subscribe after presence limit = %v, %v", allowed, err)
	}
	if allowed, err := first.AllowHandshake(ctx, user, 1, time.Minute); err != nil || !allowed {
		t.Fatalf("handshake after presence limit = %v, %v", allowed, err)
	}
}

func TestPresenceEstablishmentAndRenewalPruneCrashedDeviceScores(t *testing.T) {
	first, _, ctx, user := presenceClients(t)
	lease := acquirePresenceLease(t, first, ctx, user)
	now, err := first.redis.Time(ctx).Result()
	if err != nil {
		t.Fatal(err)
	}
	for _, operation := range []string{"establish", "renew"} {
		stale := make([]redis.Z, 100)
		for index := range stale {
			stale[index] = redis.Z{Score: float64(now.Add(-time.Second).UnixMilli()), Member: fmt.Sprintf("crashed-%d", index)}
		}
		if err := first.redis.ZAdd(ctx, connectionOnlineKey(user), stale...).Err(); err != nil {
			t.Fatal(err)
		}
		if operation == "establish" {
			establishPresenceLease(t, first, ctx, user, lease)
		} else if active, err := first.RenewConnectionLease(ctx, user, lease); err != nil || !active {
			t.Fatalf("renew: %v %v", active, err)
		}
		if count, err := first.redis.ZCard(ctx, connectionOnlineKey(user)).Result(); err != nil || count != 1 {
			t.Fatalf("%s left unbounded crashed device scores: %d %v", operation, count, err)
		}
	}
}
