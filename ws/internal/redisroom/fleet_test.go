package redisroom

import (
	"context"
	"fmt"
	"testing"
	"time"
)

func TestAdmissionCapsConnectionsAcrossGateways(t *testing.T) {
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	user := fmt.Sprintf("admission-%d", time.Now().UnixNano())
	gatewayA, gatewayB := user+"-a", user+"-b"
	t.Cleanup(func() {
		first.redis.Del(context.Background(), connectionCountKey(user), gatewayUsersKey(gatewayA), gatewayUsersKey(gatewayB))
	})
	for i := range 3 {
		client, gateway := first, gatewayA
		if i == 2 {
			client, gateway = second, gatewayB
		}
		if admitted, err := client.AdmitConnection(ctx, user, gateway, 3); err != nil || !admitted {
			t.Fatalf("admit %d = %v, %v", i, admitted, err)
		}
	}
	if admitted, err := second.AdmitConnection(ctx, user, gatewayB, 3); err != nil || admitted {
		t.Fatalf("fourth connection = %v, %v; want refused", admitted, err)
	}
	if err := first.ReleaseConnections(ctx, user, gatewayA, 1); err != nil {
		t.Fatal(err)
	}
	if admitted, err := second.AdmitConnection(ctx, user, gatewayB, 3); err != nil || !admitted {
		t.Fatalf("after release = %v, %v; want admitted", admitted, err)
	}
	if err := first.ReleaseConnections(ctx, user, gatewayA, 1); err != nil {
		t.Fatal(err)
	}
	if members, _ := first.redis.SMembers(ctx, gatewayUsersKey(gatewayA)).Result(); len(members) != 0 {
		t.Fatalf("gateway users = %v, want empty", members)
	}
	if members, _ := first.redis.SMembers(ctx, gatewayUsersKey(gatewayB)).Result(); len(members) != 1 || members[0] != user {
		t.Fatalf("gateway users = %v, want %s", members, user)
	}
	if err := second.RemoveGatewayConnections(ctx, gatewayB, []string{user}); err != nil {
		t.Fatal(err)
	}
	if fields, _ := first.redis.HGetAll(ctx, connectionCountKey(user)).Result(); len(fields) != 0 {
		t.Fatalf("counts = %v, want none", fields)
	}
}

func TestGatewayRegistryClaimsExpiredGatewaysOnce(t *testing.T) {
	first, second := connectionTestClients(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	gateway := fmt.Sprintf("gateway-%d", time.Now().UnixNano())
	t.Cleanup(func() {
		first.redis.Del(context.Background(), gatewayDeadKey(gateway), gatewayReapingKey(gateway), gatewayUsersKey(gateway))
		first.redis.ZRem(context.Background(), gatewaysKey, gateway)
	})
	if registered, dead, err := first.Heartbeat(ctx, gateway, time.Millisecond); err != nil || registered || dead {
		t.Fatalf("first heartbeat = %v, %v, %v; want new registration", registered, dead, err)
	}
	if registered, _, err := first.Heartbeat(ctx, gateway, time.Minute); err != nil || !registered {
		t.Fatalf("second heartbeat = %v, %v; want registered", registered, err)
	}
	if claimed, err := second.ClaimGateway(ctx, gateway); err != nil || claimed {
		t.Fatalf("claim of a live gateway = %v, %v", claimed, err)
	}
	if _, _, err := first.Heartbeat(ctx, gateway, time.Millisecond); err != nil {
		t.Fatal(err)
	}
	time.Sleep(5 * time.Millisecond)
	expired, err := second.ExpiredGateways(ctx, 1000)
	if err != nil || !contains(expired, gateway) {
		t.Fatalf("expired = %v, %v; want %s", expired, err, gateway)
	}
	if claimed, err := first.ClaimGateway(ctx, gateway); err != nil || !claimed {
		t.Fatalf("first claim = %v, %v", claimed, err)
	}
	if claimed, err := second.ClaimGateway(ctx, gateway); err != nil || claimed {
		t.Fatalf("second claim = %v, %v; want lost", claimed, err)
	}
	if _, dead, err := first.Heartbeat(ctx, gateway, time.Minute); err != nil || !dead {
		t.Fatalf("heartbeat after removal = dead %v, %v; want dead", dead, err)
	}
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
