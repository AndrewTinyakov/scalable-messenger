package monitoring

import (
	"strconv"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/protocol"
)

var latencyBuckets = []float64{.005, .01, .025, .05, .1, .2, .25, .5, 1, 2, 5, 10, 20, 30, 60, 120, 300}

type GatewayMetrics struct {
	BrokerEvents           *prometheus.CounterVec
	PendingACKs            prometheus.Gauge
	ACKTimeouts            prometheus.Counter
	PendingUpgrades        prometheus.Gauge
	CommandWorkers         prometheus.Gauge
	AppliedLatency         *prometheus.HistogramVec
	Closes                 *prometheus.CounterVec
	ConnectionLifetime     prometheus.Histogram
	CommandWait            *prometheus.HistogramVec
	CommandService         *prometheus.HistogramVec
	SendAdmission          *prometheus.HistogramVec
	Messages               *prometheus.CounterVec
	MessageBytes           *prometheus.CounterVec
	PingRTT                prometheus.Histogram
	ReplaySeconds          *prometheus.HistogramVec
	ReplayEvents           prometheus.Counter
	ReplayBytes            prometheus.Counter
	ContinuityReplayEvents prometheus.Counter
	ContinuityReplayBytes  prometheus.Counter
	CatchupSeconds         *prometheus.HistogramVec
	SessionChecks          *prometheus.CounterVec
	LastHeartbeat          prometheus.Gauge
}

func newGatewayMetrics(registry *prometheus.Registry) *GatewayMetrics {
	m := &GatewayMetrics{
		BrokerEvents:           prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_broker_events_total", Help: "Redis feed lifecycle and decoding outcomes."}, []string{"result"}),
		PendingACKs:            prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_pending_acks", Help: "Live message notifications awaiting applied, dismissed or received-message acknowledgement."}),
		ACKTimeouts:            prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_ack_timeouts_total", Help: "Connections whose oldest live message acknowledgement deadline expired."}),
		PendingUpgrades:        prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_pending_upgrades", Help: "Reserved upgrades awaiting admission and initial session validation."}),
		CommandWorkers:         prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_command_workers_active", Help: "Command workers currently handling an admitted command."}),
		AppliedLatency:         prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_applied_latency_seconds", Help: "Time to applied ACK for still-pending live frames, from writer offer or SQL creation; excludes frames already received or dismissed.", Buckets: latencyBuckets}, []string{"origin"}),
		Closes:                 prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_closes_total", Help: "Closed connections by bounded code and local reason; 1006 means no close frame observed or sent."}, []string{"code", "reason"}),
		ConnectionLifetime:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_connection_lifetime_seconds", Help: "Time from socket construction until close.", Buckets: prometheus.ExponentialBuckets(1, 4, 9)}),
		CommandWait:            prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_command_queue_wait_seconds", Help: "Time from local command admission until worker pickup, including commands expired in queue.", Buckets: latencyBuckets}, []string{"kind"}),
		CommandService:         prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_command_service_seconds", Help: "Worker service time after pickup; includes send admission and publish confirmation.", Buckets: latencyBuckets}, []string{"kind", "result"}),
		SendAdmission:          prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_send_admission_seconds", Help: "Redis send-rate-limit call duration.", Buckets: latencyBuckets}, []string{"result"}),
		Messages:               prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_messages_total", Help: "Successfully read or written WebSocket data messages, excluding control frames."}, []string{"direction"}),
		MessageBytes:           prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_message_bytes_total", Help: "Application payload bytes of successfully read or written WebSocket data messages, excluding framing and control traffic."}, []string{"direction"}),
		PingRTT:                prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_ping_rtt_seconds", Help: "Round-trip time of matched server ping payloads echoed by a pong.", Buckets: latencyBuckets}),
		ReplaySeconds:          prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_replay_seconds", Help: "Redis replay lookup duration including cursor and required-through continuity validation; gap includes replay caps.", Buckets: latencyBuckets}, []string{"trigger", "result"}),
		ReplayEvents:           prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_replay_events_total", Help: "Replayed events successfully admitted to recipient socket queues."}),
		ReplayBytes:            prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_replay_bytes_total", Help: "Replayed encoded payload bytes successfully admitted to recipient socket queues."}),
		ContinuityReplayEvents: prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_continuity_replay_events_total", Help: "Validated continuity replay events offered to room fanout, counted once per room replay item, independent of recipient queue acceptance."}),
		ContinuityReplayBytes:  prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_continuity_replay_bytes_total", Help: "Encoded event payload bytes offered to room fanout by continuity replay, counted once per room replay item."}),
		CatchupSeconds:         prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_catchup_seconds", Help: "Room join duration through replay and buffered-live handoff; fallback delegates complete recovery to SQL.", Buckets: latencyBuckets}, []string{"result"}),
		SessionChecks:          prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_session_checks_total", Help: "Periodic SQL session checks of open sockets by result."}, []string{"result"}),
		LastHeartbeat:          prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_gateway_last_heartbeat_timestamp_seconds", Help: "Unix time of this gateway's last heartbeat that Redis accepted; zero before the first one."}),
	}
	registry.MustRegister(m.BrokerEvents, m.PendingACKs, m.ACKTimeouts, m.PendingUpgrades, m.CommandWorkers, m.AppliedLatency, m.Closes, m.ConnectionLifetime, m.CommandWait, m.CommandService, m.SendAdmission, m.Messages, m.MessageBytes, m.PingRTT, m.ReplaySeconds, m.ReplayEvents, m.ReplayBytes, m.ContinuityReplayEvents, m.ContinuityReplayBytes, m.CatchupSeconds, m.SessionChecks, m.LastHeartbeat)
	return m
}

func (m *GatewayMetrics) RecordHeartbeat(at time.Time) {
	m.LastHeartbeat.Set(float64(at.UnixNano()) / float64(time.Second))
}

func CommandKind(kind protocol.FrameType) string {
	switch kind {
	case protocol.FrameSend, protocol.FrameSubscribe, protocol.FrameSubscribeMany, protocol.FrameUnsubscribe:
		return string(kind)
	default:
		return "other"
	}
}

func CloseCode(code int) string {
	switch code {
	case 1000, 1001, 1002, 1003, 1005, 1006, 1007, 1008, 1009, 1010, 1011, 1012, 1013, 1015, 4001, 4003:
		return strconv.Itoa(code)
	default:
		return "other"
	}
}

func (m *GatewayMetrics) ObserveApplied(offered, saved, now time.Time) {
	m.AppliedLatency.WithLabelValues("offered").Observe(max(0, now.Sub(offered).Seconds()))
	if !saved.IsZero() {
		m.AppliedLatency.WithLabelValues("saved").Observe(max(0, now.Sub(saved).Seconds()))
	}
}
