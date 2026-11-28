package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestProfilingBindsLoopbackOnly(t *testing.T) {
	listener, err := listenProfiling(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	if address := listener.Addr().(*net.TCPAddr); !address.IP.IsLoopback() {
		t.Fatalf("profiling bound to %s, want loopback", address.IP)
	}
}

func TestProfilingServesHeapAndStopsDuringCPUProfile(t *testing.T) {
	listener, err := listenProfiling(0)
	if err != nil {
		t.Fatal(err)
	}
	profiling := serveProfiling(listener, slog.New(slog.NewTextHandler(io.Discard, nil)))
	base := "http://" + listener.Addr().String() + "/debug/pprof/"
	response, err := http.Get(base + "heap?debug=1")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("heap profile status = %d, want 200", response.StatusCode)
	}
	profileDone := make(chan struct{})
	go func() {
		defer close(profileDone)
		if response, err := http.Get(base + "profile?seconds=30"); err == nil {
			_ = response.Body.Close()
		}
	}()
	time.Sleep(100 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	started := time.Now()
	profiling.Stop(ctx)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Stop took %v with a CPU profile running, want the profile cancelled", elapsed)
	}
	<-profileDone
	if _, err := http.Get(base + "heap"); err == nil {
		t.Fatal("profiling server still serving after Stop")
	}
}
