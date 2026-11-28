package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"strconv"
	"testing"
	"time"
)

func TestProfilingIsDisabledWithoutPort(t *testing.T) {
	profiling, err := startProfiling(0, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil || profiling != nil {
		t.Fatalf("startProfiling(0) = %v, %v, want disabled", profiling, err)
	}
	profiling.Stop(context.Background())
}

func TestProfilingServesHeapOnLoopbackAndStops(t *testing.T) {
	probe, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := probe.Addr().(*net.TCPAddr).Port
	_ = probe.Close()
	profiling, err := startProfiling(port, slog.New(slog.NewTextHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	url := "http://127.0.0.1:" + strconv.Itoa(port) + "/debug/pprof/heap?debug=1"
	response, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("heap profile status = %d, want 200", response.StatusCode)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	profiling.Stop(ctx)
	if _, err := http.Get(url); err == nil {
		t.Fatal("profiling server still serving after Stop")
	}
}
