package main

import (
	"context"
	"log/slog"
)

type gatewayPresence interface {
	RemoveGateway(context.Context, string) error
}

func releaseGatewayPresence(ctx context.Context, stopWriters func(), presence gatewayPresence, gateway func() string, logger *slog.Logger) {
	stopWriters()
	if err := presence.RemoveGateway(ctx, gateway()); err != nil {
		logger.Warn("clear gateway presence at shutdown; peers will reap it", "error", err)
	}
}
