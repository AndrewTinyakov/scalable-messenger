package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"slices"
	"sync"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/collectors"

	"messenger/ws/internal/config"
	"messenger/ws/internal/fleet"
	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/presence"
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
	presenceRedis := redis
	if cfg.PresenceRedisURL != cfg.RedisURL || !slices.Equal(cfg.PresenceRedisNodes, cfg.RedisClusterNodes) {
		if presenceRedis, err = redisroom.New(cfg.PresenceRedisURL, cfg.PresenceRedisNodes); err != nil {
			return err
		}
		defer presenceRedis.Close()
		presenceRedis.SetMetrics(metrics)
	}
	presenceStore := presence.RedisStore(presenceRedis)
	presenceConfig := presence.DefaultConfig()
	presenceConfig.Grace = cfg.PresenceGrace
	presenceConfig.Timeout = cfg.APITimeout
	var gateways *fleet.Fleet
	tracker := presence.NewTracker(presenceStore, groupAuth, func() string { return gateways.ID() }, presenceConfig, logger)
	gateways = fleet.New(redis, tracker, fleet.Config{ConnectionLimit: 10, Heartbeat: cfg.GatewayHeartbeat, TTL: cfg.GatewayTTL, Timeout: cfg.APITimeout, OnHeartbeat: metrics.RecordHeartbeat}, logger)
	background, stopBackground := context.WithCancel(context.WithoutCancel(ctx))
	watchers := presence.NewHub(background, presenceStore, groupAuth, presenceConfig, logger, metrics.PresenceMetrics)
	var backgroundWG sync.WaitGroup
	for _, run := range []func(context.Context){gateways.Run, tracker.Run, func(context.Context) { watchers.Run() }} {
		backgroundWG.Add(1)
		go func() { defer backgroundWG.Done(); run(background) }()
	}
	stopBackgroundWork := func() { stopBackground(); backgroundWG.Wait() }
	defer stopBackgroundWork()
	rooms := roomregistry.NewRooms(redis, logger, cfg.ReplayLimit, cfg.QueueItems, cfg.QueueBytes, cfg.PositionCheckInterval, metrics, cfg.MaxRooms, cfg.MaxMemberships)
	ws, err := socket.NewServer(context.WithoutCancel(ctx), cfg, logger, socket.Dependencies{
		GroupAuthorizer: groupAuth, SessionAuthorizer: groupAuth, Publisher: publisher,
		SendLimiter: redis, HandshakeLimiter: redis, SubscriptionLimiter: redis, Rooms: rooms,
		Admission: gateways, Presence: tracker, Watchers: watchers, WatchLimiter: redis, SidebarActivity: redis,
	}, registry, metrics)
	if err != nil {
		rooms.Close()
		return fmt.Errorf("construct WebSocket server: %w", err)
	}
	defer ws.Close()
	profiling, err := startProfiling(cfg.ProfilingPort, logger)
	if err != nil {
		logger.Warn("profiling server unavailable", "error", err)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		profiling.Stop(stopCtx)
	}()
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
		err := httpServer.Shutdown(shutdown)
		if err != nil {
			_ = httpServer.Close()
		}
		<-result
		releaseGatewayPresence(shutdown, stopBackgroundWork, tracker, gateways.ID, logger)
		return err
	}
}
