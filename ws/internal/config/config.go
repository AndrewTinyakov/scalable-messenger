package config

import (
	"fmt"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Address                string
	APIGrpcAddress         string
	APIGrpcCAFile          string
	APIGrpcCertFile        string
	APIGrpcKeyFile         string
	APIGrpcServerName      string
	WSTicketSecret         string
	RabbitURLs             []string
	RedisURL               string
	RedisClusterNodes      []string
	PresenceRedisURL       string
	PresenceRedisNodes     []string
	AllowedOrigin          string
	MaxFrameBytes          int64
	QueueItems             int
	QueueBytes             int
	PendingACKLimit        int
	MaxConnections         int
	MaxPendingUpgrades     int
	HandshakeRate          int
	HandshakeWindow        time.Duration
	MaxGroupAuths          int
	SubscribeRate          int
	SubscribeWindow        time.Duration
	MaxRoomsPerConnection  int
	MaxRooms               int
	MaxMemberships         int
	CommandWorkers         int
	CommandQueueItems      int
	CommandQueueBytes      int
	ConnectionCommandItems int
	ConnectionCommandBytes int
	DrainTimeout           time.Duration
	PublishConcurrency     int
	ReplayLimit            int64
	ConfirmTimeout         time.Duration
	APITimeout             time.Duration
	WriteTimeout           time.Duration
	ACKTimeout             time.Duration
	PongTimeout            time.Duration
	PingInterval           time.Duration
	PositionCheckInterval  time.Duration
	GroupLease             time.Duration
	ShutdownTimeout        time.Duration
	PresenceGrace          time.Duration
	IdleAfterHidden        time.Duration
	IdleAfterInput         time.Duration
	ReleaseAfterHidden     time.Duration
	GatewayHeartbeat       time.Duration
	GatewayTTL             time.Duration
}

func Load() (Config, error) {
	c := Config{}
	var err error
	c.Address = stringEnv("WS_ADDRESS", ":8081")
	c.APIGrpcAddress = stringEnv("API_GRPC_ADDRESS", "dns:///api-grpc:9090")
	c.APIGrpcCAFile = stringEnv("API_GRPC_CA_FILE", "/run/messenger-grpc/ca.pem")
	c.APIGrpcCertFile = stringEnv("API_GRPC_CERT_FILE", "/run/messenger-grpc/ws-cert.pem")
	c.APIGrpcKeyFile = stringEnv("API_GRPC_KEY_FILE", "/run/messenger-grpc/ws-key.pem")
	c.APIGrpcServerName = stringEnv("API_GRPC_SERVER_NAME", "api-grpc")
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
	c.PresenceRedisURL = stringEnv("PRESENCE_REDIS_URL", c.RedisURL)
	c.PresenceRedisNodes = c.RedisClusterNodes
	if nodes := strings.TrimSpace(stringEnv("PRESENCE_REDIS_CLUSTER_NODES", "")); nodes != "" {
		c.PresenceRedisNodes = nil
		for _, node := range strings.Split(nodes, ",") {
			if node = strings.TrimSpace(node); node == "" {
				return c, fmt.Errorf("PRESENCE_REDIS_CLUSTER_NODES contains an empty address")
			}
			c.PresenceRedisNodes = append(c.PresenceRedisNodes, node)
		}
	}
	c.AllowedOrigin = stringEnv("WS_ALLOWED_ORIGIN", "http://localhost:8080")
	if !validOrigin(c.AllowedOrigin) {
		return c, fmt.Errorf("WS_ALLOWED_ORIGIN must be a canonical HTTP or HTTPS origin")
	}
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
	if c.MaxPendingUpgrades, err = intEnv("WS_MAX_PENDING_UPGRADES", 128); err != nil {
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
	if c.MaxRooms, err = intEnv("WS_MAX_ROOMS", 100000); err != nil {
		return c, err
	}
	if c.MaxMemberships, err = intEnv("WS_MAX_MEMBERSHIPS", 1000000); err != nil {
		return c, err
	}
	if c.CommandWorkers, err = intEnv("WS_COMMAND_WORKERS", 64); err != nil {
		return c, err
	}
	if c.CommandQueueItems, err = intEnv("WS_COMMAND_QUEUE_ITEMS", 4096); err != nil {
		return c, err
	}
	if c.CommandQueueBytes, err = intEnv("WS_COMMAND_QUEUE_BYTES", 16777216); err != nil {
		return c, err
	}
	if c.ConnectionCommandItems, err = intEnv("WS_CONNECTION_COMMAND_ITEMS", 32); err != nil {
		return c, err
	}
	if c.ConnectionCommandBytes, err = intEnv("WS_CONNECTION_COMMAND_BYTES", 131072); err != nil {
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
	if c.PongTimeout, err = durationEnv("WS_PONG_TIMEOUT", 40*time.Second); err != nil {
		return c, err
	}
	if c.PingInterval, err = durationEnv("WS_PING_INTERVAL", 20*time.Second); err != nil {
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
	if c.DrainTimeout, err = durationEnv("WS_DRAIN_TIMEOUT", 5*time.Second); err != nil {
		return c, err
	}
	for _, setting := range []struct {
		target   *time.Duration
		name     string
		fallback time.Duration
	}{
		{&c.PresenceGrace, "PRESENCE_GRACE", 2 * time.Second},
		{&c.IdleAfterHidden, "PRESENCE_IDLE_AFTER_HIDDEN", 5 * time.Second},
		{&c.IdleAfterInput, "PRESENCE_IDLE_AFTER_INPUT", 30 * time.Second},
		{&c.ReleaseAfterHidden, "PRESENCE_RELEASE_AFTER_HIDDEN", 5 * time.Minute},
		{&c.GatewayHeartbeat, "WS_GATEWAY_HEARTBEAT", 5 * time.Second},
		{&c.GatewayTTL, "WS_GATEWAY_TTL", 15 * time.Second},
	} {
		if *setting.target, err = durationEnv(setting.name, setting.fallback); err != nil {
			return c, err
		}
	}
	if len(c.WSTicketSecret) < 32 || c.APIGrpcAddress == "" || c.MaxFrameBytes <= 0 || c.QueueItems <= 0 || c.QueueBytes <= 0 || c.PendingACKLimit <= 0 || c.MaxConnections <= 0 || c.MaxPendingUpgrades <= 0 || c.HandshakeRate <= 0 || c.HandshakeWindow < time.Millisecond || c.HandshakeWindow/time.Microsecond < time.Duration(c.HandshakeRate) || c.MaxGroupAuths <= 0 || c.SubscribeRate <= 0 || c.SubscribeWindow < time.Millisecond || c.SubscribeWindow/time.Microsecond < time.Duration(c.SubscribeRate) || c.MaxRoomsPerConnection <= 0 || c.MaxRooms <= 0 || c.MaxMemberships <= 0 || c.CommandWorkers <= 0 || c.CommandQueueItems <= 0 || c.CommandQueueBytes <= 0 || c.ConnectionCommandItems <= 0 || c.ConnectionCommandBytes <= 0 || c.DrainTimeout < 0 || c.DrainTimeout >= c.ShutdownTimeout || c.PublishConcurrency <= 0 || c.ReplayLimit <= 0 || c.ConfirmTimeout <= 0 || c.APITimeout <= 0 || c.WriteTimeout <= 0 || c.ACKTimeout <= 0 || c.PongTimeout <= 0 || c.PingInterval <= 0 || c.PositionCheckInterval <= 0 || c.GroupLease <= 0 || c.ShutdownTimeout <= 0 || c.PingInterval >= c.PongTimeout || c.PresenceGrace < 0 || c.IdleAfterHidden < 0 || c.IdleAfterHidden > time.Hour || c.IdleAfterInput < time.Second || c.IdleAfterInput > time.Hour || c.ReleaseAfterHidden < time.Second || c.ReleaseAfterHidden > 24*time.Hour || c.GatewayHeartbeat <= 0 || c.GatewayTTL <= c.GatewayHeartbeat {
		return c, fmt.Errorf("invalid WS capacity or timeout")
	}
	return c, nil
}

func validOrigin(value string) bool {
	origin, err := url.Parse(value)
	if err != nil || (origin.Scheme != "http" && origin.Scheme != "https") || origin.Host == "" || origin.User != nil || origin.Path != "" || origin.RawQuery != "" || origin.ForceQuery || origin.Fragment != "" || strings.Contains(value, "#") || origin.Opaque != "" || origin.Host != strings.ToLower(origin.Host) || origin.String() != value {
		return false
	}
	if strings.ContainsAny(origin.Host, "*\\") || origin.Hostname() == "" || strings.HasSuffix(origin.Host, ":") {
		return false
	}
	if strings.Contains(origin.Host, "[") {
		address, err := netip.ParseAddr(origin.Hostname())
		if err != nil || !address.Is6() || address.String() != origin.Hostname() {
			return false
		}
	}
	for _, character := range origin.Hostname() {
		if character > 127 || !((character >= 'a' && character <= 'z') || (character >= '0' && character <= '9') || strings.ContainsRune(".-:_", character)) {
			return false
		}
	}
	if port := origin.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 || strconv.Itoa(number) != port || (origin.Scheme == "http" && number == 80) || (origin.Scheme == "https" && number == 443) {
			return false
		}
	}
	return true
}
