package config

import (
	"fmt"
	"strings"
	"time"
)

type Config struct {
	Address               string
	APIGrpcAddress        string
	WSTicketSecret        string
	RabbitURLs            []string
	RedisURL              string
	RedisClusterNodes     []string
	AllowedOrigin         string
	MaxFrameBytes         int64
	QueueItems            int
	QueueBytes            int
	PendingACKLimit       int
	MaxConnections        int
	MaxPendingUpgrades    int
	HandshakeRate         int
	HandshakeWindow       time.Duration
	MaxGroupAuths         int
	SubscribeRate         int
	SubscribeWindow       time.Duration
	MaxRoomsPerConnection int
	PublishConcurrency    int
	ReplayLimit           int64
	ConfirmTimeout        time.Duration
	APITimeout            time.Duration
	WriteTimeout          time.Duration
	ACKTimeout            time.Duration
	PongTimeout           time.Duration
	PingInterval          time.Duration
	PositionCheckInterval time.Duration
	GroupLease            time.Duration
	ShutdownTimeout       time.Duration
}

func Load() (Config, error) {
	c := Config{}
	var err error
	c.Address = stringEnv("WS_ADDRESS", ":8081")
	c.APIGrpcAddress = stringEnv("API_GRPC_ADDRESS", "api-proxy:9090")
	c.WSTicketSecret = stringEnv("WS_TICKET_SECRET", "")
	for _, url := range strings.Split(stringEnv("RABBITMQ_URLS", stringEnv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")), ",") {
		url = strings.TrimSpace(url)
		if url == "" {
			return c, fmt.Errorf("RABBITMQ_URLS contains an empty address")
		}
		c.RabbitURLs = append(c.RabbitURLs, url)
	}
	c.RedisURL = stringEnv("REDIS_URL", "redis://redis:6379/0")
	if nodes := strings.TrimSpace(stringEnv("REDIS_CLUSTER_NODES", "")); nodes != "" {
		for _, node := range strings.Split(nodes, ",") {
			node = strings.TrimSpace(node)
			if node == "" {
				return c, fmt.Errorf("REDIS_CLUSTER_NODES contains an empty address")
			}
			c.RedisClusterNodes = append(c.RedisClusterNodes, node)
		}
	}
	c.AllowedOrigin = stringEnv("WS_ALLOWED_ORIGIN", "http://localhost:8080")
	if c.MaxFrameBytes, err = int64Env("WS_MAX_FRAME_BYTES", 32768); err != nil {
		return c, err
	}
	if c.QueueItems, err = intEnv("WS_QUEUE_ITEMS", 128); err != nil {
		return c, err
	}
	if c.QueueBytes, err = intEnv("WS_QUEUE_BYTES", 262144); err != nil {
		return c, err
	}
	if c.PendingACKLimit, err = intEnv("WS_PENDING_ACK_LIMIT", 256); err != nil {
		return c, err
	}
	if c.MaxConnections, err = intEnv("WS_MAX_CONNECTIONS", 10000); err != nil {
		return c, err
	}
	if c.MaxPendingUpgrades, err = intEnv("WS_MAX_PENDING_UPGRADES", 16); err != nil {
		return c, err
	}
	if c.HandshakeRate, err = intEnv("WS_HANDSHAKE_RATE", 30); err != nil {
		return c, err
	}
	if c.HandshakeWindow, err = durationEnv("WS_HANDSHAKE_WINDOW", time.Minute); err != nil {
		return c, err
	}
	if c.MaxGroupAuths, err = intEnv("WS_MAX_GROUP_AUTHS", 16); err != nil {
		return c, err
	}
	if c.SubscribeRate, err = intEnv("WS_SUBSCRIBE_RATE", 10); err != nil {
		return c, err
	}
	if c.SubscribeWindow, err = durationEnv("WS_SUBSCRIBE_WINDOW", time.Second); err != nil {
		return c, err
	}
	if c.MaxRoomsPerConnection, err = intEnv("WS_MAX_ROOMS_PER_CONNECTION", 200); err != nil {
		return c, err
	}
	if c.PublishConcurrency, err = intEnv("WS_PUBLISH_CONCURRENCY", 64); err != nil {
		return c, err
	}
	if c.ReplayLimit, err = int64Env("WS_REPLAY_LIMIT", 500); err != nil {
		return c, err
	}
	if c.ConfirmTimeout, err = durationEnv("WS_CONFIRM_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	if c.APITimeout, err = durationEnv("WS_API_TIMEOUT", 3*time.Second); err != nil {
		return c, err
	}
	if c.WriteTimeout, err = durationEnv("WS_WRITE_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	if c.ACKTimeout, err = durationEnv("WS_ACK_TIMEOUT", 30*time.Second); err != nil {
		return c, err
	}
	if c.PongTimeout, err = durationEnv("WS_PONG_TIMEOUT", 60*time.Second); err != nil {
		return c, err
	}
	if c.PingInterval, err = durationEnv("WS_PING_INTERVAL", 25*time.Second); err != nil {
		return c, err
	}
	if c.PositionCheckInterval, err = durationEnv("WS_POSITION_CHECK_INTERVAL", 30*time.Second); err != nil {
		return c, err
	}
	if c.GroupLease, err = durationEnv("WS_GROUP_LEASE", 10*time.Minute); err != nil {
		return c, err
	}
	if c.ShutdownTimeout, err = durationEnv("WS_SHUTDOWN_TIMEOUT", 10*time.Second); err != nil {
		return c, err
	}
	if len(c.WSTicketSecret) < 32 || c.APIGrpcAddress == "" || c.MaxFrameBytes <= 0 || c.QueueItems <= 0 || c.QueueBytes <= 0 || c.PendingACKLimit <= 0 || c.MaxConnections <= 0 || c.MaxPendingUpgrades <= 0 || c.HandshakeRate <= 0 || c.HandshakeWindow < time.Millisecond || c.HandshakeWindow/time.Microsecond < time.Duration(c.HandshakeRate) || c.MaxGroupAuths <= 0 || c.SubscribeRate <= 0 || c.SubscribeWindow < time.Millisecond || c.SubscribeWindow/time.Microsecond < time.Duration(c.SubscribeRate) || c.MaxRoomsPerConnection <= 0 || c.PublishConcurrency <= 0 || c.ReplayLimit <= 0 || c.ConfirmTimeout <= 0 || c.APITimeout <= 0 || c.WriteTimeout <= 0 || c.ACKTimeout <= 0 || c.PongTimeout <= 0 || c.PingInterval <= 0 || c.PositionCheckInterval <= 0 || c.GroupLease <= 0 || c.ShutdownTimeout <= 0 || c.PingInterval >= c.PongTimeout {
		return c, fmt.Errorf("invalid WS capacity or timeout")
	}
	return c, nil
}
