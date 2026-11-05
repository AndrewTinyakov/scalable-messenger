package redisroom

import (
	"context"
	"os"
	"testing"
	"time"

	"messenger/ws/internal/protocol"
	"messenger/ws/internal/roomname"
)

func TestActivitySubscriptionUsesSharedBodylessFixtureAndJoinsOnCancellation(t *testing.T) {
	client, _ := connectionTestClients(t)
	data, err := os.ReadFile("../../../contracts/fixtures/valid/sidebar-activity.json")
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := protocol.DecodeSidebarEvent(data)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	events := make(chan protocol.Event, 1)
	done := make(chan error, 1)
	go func() {
		done <- client.RunActivity(ctx, fixture.ChatID, func(event protocol.Event) {
			select {
			case events <- event:
			default:
			}
		})
	}()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		if count, err := client.redis.SPublish(ctx, Channel(roomname.Activity(fixture.ChatID)), string(data)).Result(); err != nil {
			t.Fatal(err)
		} else if count > 0 {
			break
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("activity subscription was not established")
		}
	}
	select {
	case event := <-events:
		if event.Sequence != fixture.Sequence || event.Body != "" {
			t.Fatal("activity was not bodyless")
		}
	case <-ctx.Done():
		t.Fatal("activity was not received")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("activity reader did not join")
	}
}
