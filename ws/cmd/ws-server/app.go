package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"messenger/ws/internal/config"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/rabbitmq"
	"messenger/ws/internal/redisroom"
	roomregistry "messenger/ws/internal/room"
	"messenger/ws/internal/socket"
)

func run(ctx context.Context, logger *slog.Logger) error {
	cfg, err := config.Load()
	if err != nil {
		return fmt.Errorf("load config: %w", err)
	}
	groupAuth, err := grpcauth.New(cfg.APIGrpcAddress, grpcauth.TLSConfig{
		CAFile:     cfg.APIGrpcCAFile,
		CertFile:   cfg.APIGrpcCertFile,
		KeyFile:    cfg.APIGrpcKeyFile,
		ServerName: cfg.APIGrpcServerName,
	})
	if err != nil {
		return err
	}
	defer groupAuth.Close()
	publisher, err := rabbitmq.New(cfg.RabbitURLs, cfg.PublishConcurrency, cfg.ConfirmTimeout)
	if err != nil {
		return err
	}
	defer publisher.Close()
	redis, err := redisroom.New(cfg.RedisURL, cfg.RedisClusterNodes)
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
	registry.MustRegister(collectors.NewGoCollector(), collectors.NewProcessCollector(collectors.ProcessCollectorOpts{}))
	metrics := monitoring.New(registry)
	redis.SetMetrics(metrics)
	publisher.SetMetrics(metrics)
	rooms := roomregistry.NewRooms(redis, logger, cfg.ReplayLimit, cfg.QueueItems, cfg.QueueBytes, cfg.PositionCheckInterval, metrics, cfg.MaxRooms, cfg.MaxMemberships)
	ws, err := socket.NewServer(context.WithoutCancel(ctx), cfg, logger, socket.Dependencies{
		GroupAuthorizer: groupAuth, SessionAuthorizer: groupAuth, Publisher: publisher,
		SendLimiter: redis, HandshakeLimiter: redis, ConnectionLeases: redis, SubscriptionLimiter: redis, Rooms: rooms,
	}, registry, metrics)
	if err != nil {
		rooms.Close()
		return fmt.Errorf("construct WebSocket server: %w", err)
	}
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
		ws.Drain(shutdown)
		ws.CloseContext(shutdown)
		if err := httpServer.Shutdown(shutdown); err != nil {
			_ = httpServer.Close()
			<-result
			return err
		}
		<-result
		return nil
	}
}
