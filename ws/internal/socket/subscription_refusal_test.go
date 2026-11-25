package socket

import (
	"context"
	"errors"
	"testing"

	"messenger/ws/internal/config"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/ticket"
)

func TestFullGroupAuthorizationSlotsCountTheRefusal(t *testing.T) {
	server := newTestServer(t, config.Config{MaxGroupAuths: 1, QueueItems: 8, QueueBytes: 4096}, testDependencies(&sessionRooms{}))
	connection := newConnection(server, nil, ticket.Identity{})
	t.Cleanup(connection.Close)
	server.groupAuthSlots <- struct{}{}
	t.Cleanup(func() { <-server.groupAuthSlots })

	_, err := connection.subscriptions.authorizeSubscriptionBatch(context.Background(), []string{raceChatID}, monitoring.SubscriptionRefusedFinalAuthSlots)

	if !errors.Is(err, errRateLimited) {
		t.Fatalf("error = %v, want rate limited", err)
	}
	families, err := server.registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if family.GetName() != "messenger_ws_subscription_refusals_total" {
			continue
		}
		for _, metric := range family.Metric {
			if metric.GetLabel()[0].GetValue() == "final_auth_slots" && metric.GetCounter().GetValue() == 1 {
				return
			}
		}
	}
	t.Fatal("final_auth_slots refusal was not counted")
}
