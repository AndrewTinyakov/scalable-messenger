package redisroom

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"messenger/ws/internal/roomname"
)

func TestPresencePublishesOnlyAccountTransitions(t *testing.T) {
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	user := fmt.Sprintf("presence-%d", time.Now().UnixNano())
	bucket := roomname.PresenceBucketOf(user)
	t.Cleanup(func() { first.redis.Del(context.Background(), presenceStateKey(bucket, user)) })
	listener, err := second.SubscribePresence(ctx, bucket)
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	next := func() map[string]any {
		t.Helper()
		for {
			live, err := listener.Receive(ctx)
			if err != nil {
				t.Fatal(err)
			}
			var event map[string]any
			if err := json.Unmarshal([]byte(live.Raw), &event); err != nil {
				t.Fatal(err)
			}
			if event["u"] == user {
				return event
			}
		}
	}
	set := func(gateway string, active bool) {
		t.Helper()
		if failed := first.SetPresence(ctx, gateway, map[string]bool{user: active}); len(failed) > 0 {
			t.Fatal(failed)
		}
	}
	set("a", true)
	online := next()
	if online["o"] != true {
		t.Fatalf("first transition = %v", online)
	}
	set("b", true)
	set("a", false)
	set("b", false)
	offline := next()
	if offline["o"] != false || offline["l"].(float64) <= 0 || offline["s"].(float64) <= online["s"].(float64) || offline["v"].(string) <= online["v"].(string) {
		t.Fatalf("offline transition = %v after %v", offline, online)
	}
	states, sequences, err := first.PresenceSnapshot(ctx, []string{user})
	if err != nil {
		t.Fatal(err)
	}
	if state := states[user]; state.Online || state.LastSeen == 0 || state.Version == 0 || sequences[bucket] != int64(offline["s"].(float64)) {
		t.Fatalf("snapshot = %+v, %v", state, sequences)
	}
	if ttl := first.redis.PTTL(ctx, presenceStateKey(bucket, user)).Val(); ttl <= 0 {
		t.Fatalf("offline state ttl = %v, want expiry", ttl)
	}
}
