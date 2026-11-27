package redisroom

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/redis/go-redis/v9"
)

func TestBatchedMaintenanceKeepsPerRoomOutcomes(t *testing.T) {
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

}
