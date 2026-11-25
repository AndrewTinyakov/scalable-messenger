package redisroom

import (
	"testing"

	"github.com/redis/go-redis/v9"
)

func TestClusterConnectionsShareAuthenticationAndTLS(t *testing.T) {
	client, err := New("rediss://gateway:secret@seed.example:6379/0", []string{"first.example:6379", "second.example:6379"})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = client.Close() })
	cluster := client.redis.(*redis.ClusterClient).Options()
	if cluster.Username != "gateway" || cluster.Password != "secret" || cluster.TLSConfig == nil || cluster.TLSConfig.InsecureSkipVerify {
		t.Fatal("cluster must authenticate and verify TLS")
	}
	for _, seed := range client.seeds {
		options := seed.Options()
		if options.Username != "gateway" || options.Password != "secret" || options.TLSConfig == nil || options.TLSConfig.ServerName != "" {
			t.Fatal("topology connections must authenticate and verify each node's hostname")
		}
	}
	subscription := nodeOptions(client.connectionOptions, "owner.example:6379")
	if subscription.Addr != "owner.example:6379" || subscription.Username != "gateway" || subscription.Password != "secret" || subscription.TLSConfig == nil || subscription.TLSConfig.ServerName != "" {
		t.Fatal("sharded subscriptions must authenticate and verify their owner hostname")
	}
	if subscription.TLSConfig == client.connectionOptions.TLSConfig {
		t.Fatal("subscription must own its TLS configuration")
	}
}

func TestClusterRejectsInvalidConnectionURL(t *testing.T) {
	if _, err := New("https://seed.example", []string{"seed.example:6379"}); err == nil {
		t.Fatal("cluster ignored invalid Redis URL")
	}
}
