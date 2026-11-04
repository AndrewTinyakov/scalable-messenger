package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

type run struct {
	opts            options
	http            *http.Client
	manifest        manifest
	prefix          string
	mixed           *mixedWorkload
	baseline        uint64
	sent            atomic.Int64
	attempted       atomic.Int64
	queued          atomic.Int64
	errors          atomic.Int64
	errorCodes      sync.Map
	latencySlow     atomic.Int64
	latencyP99Slow  atomic.Int64
	latencyObserved atomic.Int64
	closes          atomic.Int64
	reconnect       atomic.Int64
	latency         [len(latencyBounds) + 1]atomic.Int64
	trace           *latencyTrace
	clients         []*client
	workers         sync.WaitGroup
}

func execute(opts options) error {
	root, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(root, opts.setupTimeout+opts.duration+opts.verificationTimeout+30*time.Second)
	defer cancel()
	setup, finishSetup := context.WithTimeout(ctx, opts.setupTimeout)
	defer finishSetup()
	work := &run{opts: opts, http: &http.Client{Timeout: 15 * time.Second}, prefix: "capacity_" + ulid() + "|"}
	if opts.traceFile != "" {
		trace, err := openLatencyTrace(opts.traceFile, opts.traceSampleEvery)
		if err != nil {
			return err
		}
		work.trace = trace
		defer trace.close()
	}
	if err := work.prepare(setup); err != nil {
		return err
	}
	if opts.connections > len(work.manifest.Sessions)*10 {
		return fmt.Errorf("%d connections exceed 10 per provisioned session", opts.connections)
	}
	var cleanupOnce sync.Once
	cleanup := func() {
		cleanupOnce.Do(func() {
			cancel()
			for _, socket := range work.clients {
				socket.interrupt()
			}
			work.workers.Wait()
			work.http.CloseIdleConnections()
			work.trace.close()
		})
	}
	defer cleanup()
	var observer *metricObserver
	if opts.observeMetrics {
		observer = &metricObserver{project: opts.composeProject, peak: make(map[string]float64)}
		baseline, err := observer.snapshot(setup)
		if err != nil {
			return err
		}
		observer.baseline = metricTotals(baseline)
		if err := observer.record(baseline); err != nil {
			return err
		}
		work.workers.Add(1)
		go func() { defer work.workers.Done(); observer.loop(ctx) }()
	}
	ramp := time.NewTicker(time.Duration(float64(time.Second) / opts.ramp))
	defer ramp.Stop()
	for index := range opts.connections {
		if index > 0 {
			select {
			case <-ramp.C:
			case <-setup.Done():
				return setup.Err()
			}
		}
		socket := &client{index: index, owner: work, session: work.manifest.Sessions[index%len(work.manifest.Sessions)], slow: opts.mode == "slow" && index >= opts.connections-opts.slowReaders, ready: make(chan struct{}), setupError: make(chan error, 1)}
		socket.sequence = work.baseline
		if work.mixed != nil {
			socket.chats = work.mixed.clientChats(socket.session.UserID)
		}
		work.clients = append(work.clients, socket)
		work.workers.Add(1)
		go func() { defer work.workers.Done(); socket.loop(ctx) }()
	}
	for _, socket := range work.clients {
		select {
		case <-socket.ready:
		case err := <-socket.setupError:
			return fmt.Errorf("connect user %s: %w", socket.session.UserID, err)
		case <-setup.Done():
			return setup.Err()
		}
	}
	finishSetup()
	fmt.Fprintf(os.Stderr, "%d sockets ready; starting %s for %s\n", len(work.clients), opts.mode, opts.duration)
	measurement, endMeasurement := context.WithTimeout(ctx, opts.duration)
	defer endMeasurement()
	if err := work.measure(measurement); err != nil {
		return err
	}
	verify, endVerification := context.WithTimeout(ctx, opts.verificationTimeout)
	defer endVerification()
	for !work.complete() && verify.Err() == nil {
		if !wait(verify, 100*time.Millisecond) {
			break
		}
	}
	if work.mixed != nil && !work.mixedComplete() {
		work.errors.Add(1)
	}
	report := work.report()
	if report["connectedAtEnd"].(int) != opts.connections && opts.mode != "slow" {
		work.errors.Add(1)
	}
	cleanup()
	if observer != nil {
		cleanupCtx, finishCleanup := context.WithTimeout(root, opts.verificationTimeout)
		err := observer.verifyCleanup(cleanupCtx)
		finishCleanup()
		if err != nil {
			work.errors.Add(1)
			observer.failures = append(observer.failures, err.Error())
		}
		report["metrics"] = map[string]any{"samples": observer.samples, "peakFleet": observer.peak, "baseline": observer.baseline, "afterCleanup": observer.afterCleanup, "cleanupVerified": err == nil, "failures": observer.failures}
	}
	if work.trace != nil {
		report["trace"] = work.trace.report()
	}
	report["errorFramesAndFailures"] = work.errors.Load()
	if err := json.NewEncoder(os.Stdout).Encode(report); err != nil {
		return err
	}
	if root.Err() != nil {
		return root.Err()
	}
	if report["missingHealthyNotifications"].(int64) > 0 || work.errors.Load() > 0 || work.queued.Load() != work.sent.Load() {
		return errors.New("workload verification failed; see JSON counts and missing deliveries")
	}
	if !work.latencySLOMet() {
		return errors.New("p95 notification latency exceeded -p95-limit")
	}
	if !work.latencyP99SLOMet() {
		return errors.New("p99 notification latency exceeded -p99-limit")
	}
	if work.trace != nil && !work.trace.complete() {
		return errors.New("latency trace incomplete; see trace drop and write failure counts")
	}
	if (opts.mode == "reconnect" || opts.mode == "drain") && work.reconnect.Load() == 0 {
		return errors.New("no socket reconnected during the disruption")
	}
	return nil
}

func wait(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-timer.C:
		return true
	case <-ctx.Done():
		return false
	}
}
