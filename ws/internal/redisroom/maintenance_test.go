package redisroom

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestBatchedMaintenanceKeepsPerRoomAndLeaseOutcomes(t *testing.T) {
	client, _ := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	room := fmt.Sprintf("user:maintenance-%d", time.Now().UnixNano())
	badRoom := room + "-bad"
	client.redis.Set(ctx, EpochKey(room), "epoch", time.Minute)
	client.redis.XAdd(ctx, &redis.XAddArgs{Stream: StreamKey(room), ID: "1-0", Values: map[string]any{"event": "test"}})
	client.redis.Set(ctx, StreamKey(badRoom), "wrong-type", time.Minute)
	for _, key := range []string{EpochKey(room), StreamKey(room), StreamKey(badRoom)} {
		defer client.redis.Del(ctx, key)
	}
	positions, err := client.TailBatch(ctx, []string{room, badRoom, "bad{}"})
	if err != nil {
		t.Fatal(err)
	}
	if position := positions[room]; position.Err != nil || position.Epoch != "epoch" || position.StreamID != "1-0" {
		t.Fatalf("position=%+v", position)
	}
	if positions[badRoom].Err == nil || positions["bad{}"].Err == nil {
		t.Fatal("invalid rooms lost their failure outcomes")
	}
	user := fmt.Sprintf("maintenance-user-%d", time.Now().UnixNano())
	lease, allowed, err := client.AcquireConnectionLease(ctx, user)
	if err != nil || !allowed {
		t.Fatalf("acquire=%v,%v", allowed, err)
	}
	defer client.ReleaseConnectionLease(ctx, user, lease)
	results := client.RenewConnectionLeases(ctx, []ConnectionLease{{UserID: user, LeaseID: lease}, {UserID: user, LeaseID: "released"}, {}})
	if len(results) != 3 || !results[0].Active || results[0].Err != nil || results[1].Active || results[1].Err != nil || results[2].Err == nil {
		t.Fatalf("renew results=%+v", results)
	}
}
