package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	runtimepprof "runtime/pprof"
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
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), time.Second)
		defer cancel()
		profiling.Stop(ctx)
	})
	base := "http://" + listener.Addr().String() + "/debug/pprof/"
	response, err := http.Get(base + "heap?debug=1")
	if err != nil {
		t.Fatal(err)
	}
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("heap profile status = %d, want 200", response.StatusCode)
	}
	profileStatus := make(chan int, 1)
	go func() {
		response, err := http.Get(base + "profile?seconds=30")
		if err != nil {
			profileStatus <- 0
			return
		}
		_ = response.Body.Close()
		profileStatus <- response.StatusCode
	}()
	waitForActiveCPUProfile(t)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	started := time.Now()
	profiling.Stop(ctx)
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("Stop took %v with a CPU profile running, want the profile cancelled", elapsed)
	}
	if status := <-profileStatus; status != http.StatusOK {
		t.Fatalf("cancelled CPU profile status = %d, want 200 with the partial profile", status)
	}
	if _, err := http.Get(base + "heap"); err == nil {
		t.Fatal("profiling server still serving after Stop")
	}
}

func waitForActiveCPUProfile(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if err := runtimepprof.StartCPUProfile(io.Discard); err != nil {
			return
		}
		runtimepprof.StopCPUProfile()
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("CPU profile never became active")
}
