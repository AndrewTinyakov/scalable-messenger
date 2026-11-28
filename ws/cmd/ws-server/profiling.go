package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
	"strconv"
	"time"
)

type profilingServer struct {
	server *http.Server
	served chan struct{}
}

func startProfiling(port int, logger *slog.Logger) (*profilingServer, error) {
	if port == 0 {
		return nil, nil
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
	if err != nil {
		return nil, err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", pprof.Profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	profiling := &profilingServer{
		server: &http.Server{Handler: mux, ReadHeaderTimeout: 5 * time.Second},
		served: make(chan struct{}),
	}
	go func() {
		defer close(profiling.served)
		if err := profiling.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("profiling server stopped", "error", err)
		}
	}()
	logger.Info("profiling server listening on loopback", "address", listener.Addr().String())
	return profiling, nil
}

func (p *profilingServer) Stop(ctx context.Context) {
	if p == nil {
		return
	}
	if err := p.server.Shutdown(ctx); err != nil {
		_ = p.server.Close()
	}
	<-p.served
}
