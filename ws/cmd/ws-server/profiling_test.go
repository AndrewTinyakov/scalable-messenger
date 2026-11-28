package main

import (
	"context"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/pprof"
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
	profileStarted := make(chan struct{})
	profile := func(w http.ResponseWriter, r *http.Request) {
		close(profileStarted)
		pprof.Profile(w, r)
	}
	profiling := serveProfiling(listener, profilingHandler(profile), slog.New(slog.NewTextHandler(io.Discard, nil)))
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
	<-profileStarted
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
