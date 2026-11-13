package monitoring

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"
)

type HandshakeStage string

const (
	HandshakeAdmission         HandshakeStage   = "admission"
	HandshakeConnectionLease   HandshakeStage   = "connection_lease"
	HandshakeHTTPUpgrade       HandshakeStage   = "http_upgrade"
	HandshakeUserRoomJoin      HandshakeStage   = "user_room_join"
	HandshakeSessionValidation HandshakeStage   = "session_validation"
	HandshakePresenceEstablish HandshakeStage   = "presence_establishment"
	HandshakeSetupCanceled     HandshakeOutcome = "canceled"
)

type HandshakeMetrics struct {
	setupSeconds *prometheus.HistogramVec
	stageSeconds *prometheus.HistogramVec
}

func NewHandshakeMetrics(registry *prometheus.Registry) *HandshakeMetrics {
	m := &HandshakeMetrics{
		setupSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_handshake_setup_seconds", Help: "WebSocket setup duration from gateway handler entry to acceptance before the socket read loop, or setup failure; excludes socket lifetime.", Buckets: latencyBuckets}, []string{"result"}),
		stageSeconds: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_handshake_stage_seconds", Help: "WebSocket setup stage duration; admission includes ticket, origin, local capacity and handshake rate limiting. Only entered stages are observed.", Buckets: latencyBuckets}, []string{"stage", "result"}),
	}
	registry.MustRegister(m.setupSeconds, m.stageSeconds)
	return m
}

type handshakeSetupState uint8

const (
	handshakeStageActive handshakeSetupState = iota
	handshakeStageComplete
	handshakeSetupFinished
)

type HandshakeSetup struct {
	metrics      *HandshakeMetrics
	started      time.Time
	stageStarted time.Time
	stage        HandshakeStage
	state        handshakeSetupState
}

func (m *HandshakeMetrics) BeginHandshake() HandshakeSetup {
	now := time.Now()
	return HandshakeSetup{metrics: m, started: now, stageStarted: now, stage: HandshakeAdmission}
}

func (setup *HandshakeSetup) NextStage(stage HandshakeStage) {
	if setup.state == handshakeSetupFinished {
		return
	}
	setup.CompleteStage()
	setup.stage = stage
	setup.stageStarted = time.Now()
	setup.state = handshakeStageActive
}

func (setup *HandshakeSetup) CompleteStage() {
	setup.observeStage("ready", time.Now())
}

func (setup *HandshakeSetup) Finish(outcome HandshakeOutcome) {
	if setup.state == handshakeSetupFinished {
		return
	}
	now := time.Now()
	result := handshakeResult(outcome)
	setup.observeStage(result, now)
	setup.metrics.setupSeconds.WithLabelValues(result).Observe(now.Sub(setup.started).Seconds())
	setup.state = handshakeSetupFinished
}

func (setup *HandshakeSetup) observeStage(result string, now time.Time) {
	if setup.state != handshakeStageActive {
		return
	}
	stage := setup.stage
	switch stage {
	case HandshakeAdmission, HandshakeConnectionLease, HandshakeHTTPUpgrade, HandshakeUserRoomJoin, HandshakeSessionValidation, HandshakePresenceEstablish:
	default:
		stage = "other"
	}
	setup.metrics.stageSeconds.WithLabelValues(string(stage), result).Observe(now.Sub(setup.stageStarted).Seconds())
	setup.state = handshakeStageComplete
}

func handshakeResult(outcome HandshakeOutcome) string {
	switch outcome {
	case HandshakeInvalidTicket, HandshakeInvalidOrigin, HandshakeCapacity,
		HandshakeLimitUnavailable, HandshakeRateLimited, HandshakeLeaseUnavailable,
		HandshakeUserCapacity, HandshakeUpgradeError, HandshakeRoomJoinFailed,
		HandshakeSessionRevoked, HandshakeSessionUnavailable, HandshakeSessionMismatch,
		HandshakeAccepted, HandshakeSetupCanceled:
		return string(outcome)
	default:
		return "other"
	}
}
