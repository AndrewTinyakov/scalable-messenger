package main

import (
	"errors"
	"flag"
	"math"
	"os"
	"strings"
	"time"
)

type options struct {
	observeMetrics                                                                                                            bool
	mode, apiURL, wsURL, origin, sessionsFile, saveSessions, scenarioFile, groupID, drainContainer, composeProject, traceFile string
	connections, bootstrapUsers, slowReaders, senders, payloadBytes, maxMessages, traceSampleEvery                            int
	rate, ramp                                                                                                                float64
	p95Limit, p99Limit, duration, setupTimeout, verificationTimeout                                                           time.Duration
}

func parseOptions() (options, error) {
	var opts options
	flag.StringVar(&opts.mode, "mode", "idle", "idle, fanout, slow, reconnect, drain, or mixed")
	flag.StringVar(&opts.apiURL, "api-url", env("MESSENGER_API_BASE_URL", "http://localhost:8081/api"), "public API base URL")
	flag.StringVar(&opts.wsURL, "ws-url", env("MESSENGER_WS_URL", "ws://localhost:8082/ws"), "public WebSocket URL")
	flag.StringVar(&opts.origin, "origin", env("MESSENGER_CLIENT_ORIGIN", "http://localhost:8080"), "allowed client origin")
	flag.StringVar(&opts.sessionsFile, "sessions", "", "JSON manifest of existing userId/cookie sessions and optional groupId")
	flag.StringVar(&opts.saveSessions, "save-sessions", "", "write provisioned manifest to a new file with mode 0600")
	flag.StringVar(&opts.scenarioFile, "scenario", "", "seeded multi-group workload JSON, required by mixed mode")
	flag.StringVar(&opts.groupID, "group-id", "", "existing group containing all manifest users")
	flag.StringVar(&opts.drainContainer, "drain-container", "", "WS container to stop during drain mode")
	flag.StringVar(&opts.composeProject, "compose-project", "", "matching Docker Compose project for drain and metrics observation")
	flag.IntVar(&opts.connections, "connections", 100, "number of concurrent sockets, at most 10 per user")
	flag.IntVar(&opts.bootstrapUsers, "bootstrap-users", 0, "register this many disposable users instead of loading a manifest")
	flag.IntVar(&opts.slowReaders, "slow-readers", 1, "sockets that stop reading after subscription in slow mode")
	flag.IntVar(&opts.senders, "senders", 1, "distinct users publishing group messages")
	flag.IntVar(&opts.payloadBytes, "payload-bytes", 256, "ASCII message body bytes, at most 4000")
	flag.IntVar(&opts.maxMessages, "max-messages", 100000, "bound on attempted messages across all senders")
	flag.Float64Var(&opts.rate, "rate", 5, "messages per second per sender, at most 20")
	flag.Float64Var(&opts.ramp, "ramp", 3, "initial connections opened per second")
	flag.DurationVar(&opts.duration, "duration", 30*time.Second, "measurement duration after every socket is ready")
	flag.DurationVar(&opts.setupTimeout, "setup-timeout", 15*time.Minute, "deadline for provisioning and connection ramp")
	flag.DurationVar(&opts.verificationTimeout, "verification-timeout", 20*time.Second, "bounded wait for queued messages to reach healthy readers")
	flag.DurationVar(&opts.p95Limit, "p95-limit", 0, "fail if over 5 percent of measured notifications exceed this latency; zero disables")
	flag.BoolVar(&opts.observeMetrics, "observe-metrics", false, "sample WS queue bounds and verify cleanup in -compose-project")
	flag.DurationVar(&opts.p99Limit, "p99-limit", 0, "fail if over 1 percent of measured notifications exceed this latency; zero disables")
	flag.StringVar(&opts.traceFile, "trace-file", "", "write sampled send, queued and notification timing as bounded NDJSON to a new file with mode 0600")
	flag.IntVar(&opts.traceSampleEvery, "trace-sample-every", 16, "trace approximately one in this many request IDs, including all their notifications; requires -trace-file")
	flag.Parse()
	if err := opts.validate(); err != nil {
		return opts, err
	}
	return opts, nil
}

func (opts options) validate() error {
	if !strings.Contains("|idle|fanout|slow|reconnect|drain|mixed|", "|"+opts.mode+"|") || opts.connections < 1 || opts.connections > 1000000 || opts.bootstrapUsers < 0 || opts.bootstrapUsers > 1000000 || opts.senders < 1 || opts.senders > opts.connections || opts.payloadBytes < 80 || opts.payloadBytes > 4000 || opts.maxMessages < 1 || math.IsNaN(opts.rate) || math.IsNaN(opts.ramp) || opts.rate <= 0 || opts.rate > 20 || opts.ramp <= 0 || opts.ramp > 100000 || opts.duration <= 0 || opts.duration > 24*time.Hour || opts.setupTimeout <= 0 || opts.setupTimeout > 24*time.Hour || opts.verificationTimeout <= 0 || opts.verificationTimeout > 24*time.Hour {
		return errors.New("invalid workload options")
	}
	if (opts.mode == "mixed") != (opts.scenarioFile != "") {
		return errors.New("mixed mode requires -scenario; other modes do not accept it")
	}
	if opts.mode == "mixed" && (opts.groupID != "" || opts.maxMessages > 100000 || opts.connections > 50000 || opts.bootstrapUsers > 10000) {
		return errors.New("mixed mode supports at most 10000 users, 50000 sockets and 100000 messages, without -group-id")
	}
	if opts.p95Limit < 0 || opts.p99Limit < 0 {
		return errors.New("p95 and p99 latency limits cannot be negative")
	}
	if opts.traceFile != "" && opts.traceSampleEvery < 1 {
		return errors.New("-trace-sample-every must be positive")
	}
	if opts.mode == "slow" && (opts.slowReaders < 1 || opts.slowReaders >= opts.connections || opts.senders > opts.connections-opts.slowReaders) {
		return errors.New("slow mode needs healthy senders and at least one paused reader")
	}
	if opts.observeMetrics && opts.composeProject == "" {
		return errors.New("-observe-metrics requires -compose-project")
	}
	if opts.mode == "drain" && (opts.drainContainer == "" || opts.composeProject == "") {
		return errors.New("drain mode requires -drain-container and -compose-project")
	}
	return nil
}

func env(name, fallback string) string {
	if value := os.Getenv(name); value != "" {
		return value
	}
	return fallback
}
