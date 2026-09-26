package config

import (
	"fmt"
	"os"
	"strconv"
	"time"
)

type Config struct {
	Address               string
	APIURL                string
	RabbitURL             string
	RedisURL              string
	AllowedOrigin         string
	MaxFrameBytes         int64
	QueueItems            int
	QueueBytes            int
	PendingACKLimit       int
	MaxConnections        int
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
	ReauthorizeInterval   time.Duration
	ShutdownTimeout       time.Duration
}

func Load() (Config, error) {
	c := Config{}
	var err error
	c.Address = stringEnv("WS_ADDRESS", ":8081")
	c.APIURL = stringEnv("API_URL", "http://api-proxy:8080")
	c.RabbitURL = stringEnv("RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672/")
	c.RedisURL = stringEnv("REDIS_URL", "redis://redis:6379/0")
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
	if c.MaxRoomsPerConnection, err = intEnv("WS_MAX_ROOMS_PER_CONNECTION", 100); err != nil {
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
	if c.ReauthorizeInterval, err = durationEnv("WS_REAUTHORIZE_INTERVAL", 60*time.Second); err != nil {
		return c, err
	}
	if c.ShutdownTimeout, err = durationEnv("WS_SHUTDOWN_TIMEOUT", 10*time.Second); err != nil {
		return c, err
	}
	if c.MaxFrameBytes <= 0 || c.QueueItems <= 0 || c.QueueBytes <= 0 || c.PendingACKLimit <= 0 || c.MaxConnections <= 0 || c.MaxRoomsPerConnection <= 0 || c.PublishConcurrency <= 0 || c.ReplayLimit <= 0 || c.ConfirmTimeout <= 0 || c.APITimeout <= 0 || c.WriteTimeout <= 0 || c.ACKTimeout <= 0 || c.PongTimeout <= 0 || c.PingInterval <= 0 || c.PositionCheckInterval <= 0 || c.ReauthorizeInterval <= 0 || c.ShutdownTimeout <= 0 || c.PingInterval >= c.PongTimeout {
		return c, fmt.Errorf("invalid WS capacity or timeout")
	}
	return c, nil
}

func stringEnv(key, fallback string) string {
	if v, ok := os.LookupEnv(key); ok {
		return v
	}
	return fallback
}
func intEnv(key string, fallback int) (int, error) {
	if v, ok := os.LookupEnv(key); ok {
		n, e := strconv.Atoi(v)
		if e != nil {
			return 0, fmt.Errorf("%s: %w", key, e)
		}
		return n, nil
	}
	return fallback, nil
}
func int64Env(key string, fallback int64) (int64, error) {
	if v, ok := os.LookupEnv(key); ok {
		n, e := strconv.ParseInt(v, 10, 64)
		if e != nil {
			return 0, fmt.Errorf("%s: %w", key, e)
		}
		return n, nil
	}
	return fallback, nil
}
func durationEnv(key string, fallback time.Duration) (time.Duration, error) {
	if v, ok := os.LookupEnv(key); ok {
		n, e := time.ParseDuration(v)
		if e != nil {
			return 0, fmt.Errorf("%s: %w", key, e)
		}
		return n, nil
	}
	return fallback, nil
}
