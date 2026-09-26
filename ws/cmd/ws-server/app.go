package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"messenger/ws/internal/apiclient"
	"messenger/ws/internal/config"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/rabbitmq"
	"messenger/ws/internal/redisroom"
	"messenger/ws/internal/socket"
)

func run(ctx context.Context, logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	api, err := apiclient.New(cfg.APIURL, cfg.APITimeout)
	if err != nil {
		return err
	}
	publisher, err := rabbitmq.New(cfg.RabbitURL, cfg.PublishConcurrency, cfg.ConfirmTimeout)
	if err != nil {
		return err
	}
	defer publisher.Close()
	redis, err := redisroom.New(cfg.RedisURL)
	if err != nil {
		return err
	}
	defer redis.Close()
	checkCtx, cancel := context.WithTimeout(ctx, cfg.APITimeout)
	err = redis.Ping(checkCtx)
	cancel()
	if err != nil {
		return fmt.Errorf("connect Redis: %w", err)
	}
	registry := prometheus.NewRegistry()
	metrics := monitoring.New(registry)
	ws := socket.NewServer(ctx, cfg, logger, api, publisher, redis, registry, metrics)
	defer ws.Close()
	httpServer := &http.Server{Addr: cfg.Address, Handler: ws.Handler(), ReadHeaderTimeout: 5 * time.Second}
	result := make(chan error, 1)
	go func() { result <- httpServer.ListenAndServe() }()
	logger.Info("WebSocket server listening", "address", cfg.Address, "maxConnections", cfg.MaxConnections, "queueBytes", cfg.QueueBytes)
	select {
	case err := <-result:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), cfg.ShutdownTimeout)
		defer cancel()
		if err := httpServer.Shutdown(shutdown); err != nil {
			return err
		}
		return nil
	}
}
