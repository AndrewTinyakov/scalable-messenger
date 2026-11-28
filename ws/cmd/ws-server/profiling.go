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
	server        *http.Server
	cancelRequest context.CancelFunc
	served        chan struct{}
}

func listenProfiling(port int) (net.Listener, error) {
	return net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
}

func profilingHandler(profile http.HandlerFunc) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/debug/pprof/", pprof.Index)
	mux.HandleFunc("/debug/pprof/cmdline", pprof.Cmdline)
	mux.HandleFunc("/debug/pprof/profile", profile)
	mux.HandleFunc("/debug/pprof/symbol", pprof.Symbol)
	mux.HandleFunc("/debug/pprof/trace", pprof.Trace)
	return mux
}

func serveProfiling(listener net.Listener, handler http.Handler, logger *slog.Logger) *profilingServer {
	requests, cancelRequest := context.WithCancel(context.Background())
	profiling := &profilingServer{
		server: &http.Server{
			Handler:           handler,
			ReadHeaderTimeout: 5 * time.Second,
			BaseContext:       func(net.Listener) context.Context { return requests },
		},
		cancelRequest: cancelRequest,
		served:        make(chan struct{}),
	}
	go func() {
		defer close(profiling.served)
		if err := profiling.server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Warn("profiling server stopped", "error", err)
		}
	}()
	logger.Info("profiling server listening on loopback", "address", listener.Addr().String())
	return profiling
}

func (p *profilingServer) Stop(ctx context.Context) {
	p.cancelRequest()
	if err := p.server.Shutdown(ctx); err != nil {
		_ = p.server.Close()
	}
	<-p.served
}
