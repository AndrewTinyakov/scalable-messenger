package monitoring

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/protocol"
)

type Metrics struct {
	*HandshakeMetrics
	*GatewayMetrics
	*PresenceMetrics
	*FeatureMetrics
	capacity             *prometheus.GaugeVec
	QueuedItems          prometheus.Gauge
	CommandItems         prometheus.Gauge
	CommandBytes         prometheus.Gauge
	LeaseCleanupDropped  prometheus.Counter
	Draining             prometheus.Gauge
	Connections          prometheus.Gauge
	handshake            *prometheus.CounterVec
	applied              *prometheus.CounterVec
	dismissed            *prometheus.CounterVec
	receivedMessages     *prometheus.CounterVec
	frameErrors          *prometheus.CounterVec
	RecoveryCloses       prometheus.Counter
	GroupLeaseExpired    prometheus.Counter
	groupAuthSeconds     *prometheus.HistogramVec
	subscriptionRefusals *prometheus.CounterVec
	RoomSubscriptions    prometheus.Gauge
	RoomMemberships      prometheus.Gauge
	QueuedBytes          prometheus.Gauge
	SlowCloses           prometheus.Counter
	publishSeconds       *prometheus.HistogramVec
	replay               *prometheus.CounterVec
	SQLFallback          prometheus.Counter
	StaleRooms           prometheus.Counter
	PositionSweep        prometheus.Histogram
	OldestPositionAge    prometheus.Gauge
	FanoutRecipients     prometheus.Histogram
	FanoutSeconds        prometheus.Histogram
	SavedEventLag        prometheus.Histogram

	publishCapacityWait       *prometheus.HistogramVec
	publishQueueWait          *prometheus.HistogramVec
	publishChannelAcquisition *prometheus.HistogramVec
	publishConfirmation       *prometheus.HistogramVec
}

func New(registry *prometheus.Registry) *Metrics {
	m := &Metrics{
		HandshakeMetrics:     NewHandshakeMetrics(registry),
		GatewayMetrics:       newGatewayMetrics(registry),
		PresenceMetrics:      newPresenceMetrics(registry),
		FeatureMetrics:       newFeatureMetrics(registry),
		capacity:             prometheus.NewGaugeVec(prometheus.GaugeOpts{Name: "messenger_ws_capacity", Help: "Configured node and per-socket resource bounds."}, []string{"resource"}),
		QueuedItems:          prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_queued_items", Help: "Items in outbound socket queues."}),
		CommandItems:         prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_command_items", Help: "Admitted socket commands waiting or running."}),
		CommandBytes:         prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_command_bytes", Help: "Wire bytes of admitted socket commands."}),
		LeaseCleanupDropped:  prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_lease_cleanup_dropped_total", Help: "Lease releases left to expire after cleanup queue capacity or closure."}),
		Draining:             prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_draining", Help: "One when this gateway is draining connections."}),
		Connections:          prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_connections", Help: "Active browser WebSocket connections."}),
		handshake:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_handshakes_total", Help: "WebSocket handshake and initial room join outcomes."}, []string{"result"}),
		applied:              prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_applied_total", Help: "Device-applied acknowledgement outcomes."}, []string{"result"}),
		dismissed:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_dismissed_total", Help: "Explicitly dismissed message interval outcomes."}, []string{"result"}),
		receivedMessages:     prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_received_messages_total", Help: "Exact live-message notification receipt outcomes."}, []string{"result"}),
		frameErrors:          prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_error_frames_total", Help: "Error frames sent to browser clients by bounded reason."}, []string{"code"}),
		RecoveryCloses:       prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_recovery_closes_total", Help: "Sockets closed because the client must recover state."}),
		GroupLeaseExpired:    prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_group_lease_expired_total", Help: "Group subscriptions removed when their renewal lease expired."}),
		subscriptionRefusals: prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_subscription_refusals_total", Help: "Group subscriptions refused before authorization, by reason."}, []string{"reason"}),
		groupAuthSeconds:     prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_group_authorization_seconds", Help: "gRPC group subscription authorization latency."}, []string{"result"}),
		RoomSubscriptions:    prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_room_subscriptions", Help: "Active room subscriptions on this node."}),
		RoomMemberships:      prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_room_memberships", Help: "Local socket memberships across all rooms."}),
		QueuedBytes:          prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_queued_bytes", Help: "Bytes in outbound socket queues."}),
		SlowCloses:           prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_slow_closes_total", Help: "Connections closed because their outbound queue filled."}),
		publishSeconds:       prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_seconds", Help: "RabbitMQ publish latency through broker confirmation.", Buckets: latencyBuckets}, []string{"result"}),
		replay:               prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_replay_total", Help: "Short Redis history replay outcomes."}, []string{"result"}),
		SQLFallback:          prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_sql_fallback_total", Help: "Client recovery requests requiring SQL history."}),
		StaleRooms:           prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_stale_rooms_total", Help: "Room feeds found stale by Redis errors or position checks."}),
		PositionSweep:        prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_position_sweep_seconds", Help: "Wall time for one sweep of local room positions.", Buckets: prometheus.ExponentialBuckets(0.01, 2, 14)}),
		OldestPositionAge:    prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_oldest_room_position_seconds", Help: "Longest time since an active room's last successful position check or live publication."}),
		FanoutRecipients:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_fanout_recipients", Help: "Local recipients considered for each room event.", Buckets: prometheus.ExponentialBuckets(1, 4, 10)}),
		FanoutSeconds:        prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_fanout_seconds", Help: "Local room-event fanout duration."}),
		SavedEventLag:        prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_saved_event_lag_seconds", Help: "Time from SQL message creation to a live WS room event; includes publisher delay.", Buckets: latencyBuckets}),

		publishCapacityWait:       prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_capacity_wait_seconds", Help: "RabbitMQ publisher capacity reservation duration, including waits that fail before admission.", Buckets: latencyBuckets}, []string{"result"}),
		publishQueueWait:          prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_queue_wait_seconds", Help: "RabbitMQ publisher job queue duration until worker pickup or shutdown drain; excludes channel acquisition.", Buckets: latencyBuckets}, []string{"result"}),
		publishChannelAcquisition: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_channel_acquisition_seconds", Help: "RabbitMQ publisher channel acquisition duration including connection, topology declaration, confirm setup and broker failover.", Buckets: latencyBuckets}, []string{"result"}),
		publishConfirmation:       prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_confirmation_seconds", Help: "RabbitMQ publisher duration from wire send attempt to confirmation or final transport failure, even after caller cancellation.", Buckets: latencyBuckets}, []string{"result"}),
	}
	registry.MustRegister(m.capacity, m.QueuedItems, m.CommandItems, m.CommandBytes, m.LeaseCleanupDropped, m.Draining, m.Connections, m.handshake, m.applied, m.dismissed, m.receivedMessages, m.frameErrors, m.RecoveryCloses, m.GroupLeaseExpired, m.groupAuthSeconds, m.subscriptionRefusals, m.RoomSubscriptions, m.RoomMemberships, m.QueuedBytes, m.SlowCloses, m.publishSeconds, m.replay, m.SQLFallback, m.StaleRooms, m.PositionSweep, m.OldestPositionAge, m.FanoutRecipients, m.FanoutSeconds, m.SavedEventLag)
	registry.MustRegister(m.publishCapacityWait, m.publishQueueWait, m.publishChannelAcquisition, m.publishConfirmation)
	return m
}

func (m *Metrics) ObservePublish(duration time.Duration, outcome PublishOutcome) {
	m.publishSeconds.WithLabelValues(string(outcome)).Observe(duration.Seconds())
}

func (m *Metrics) ObservePublishCapacityWait(duration time.Duration, outcome PublishStageOutcome) {
	m.publishCapacityWait.WithLabelValues(string(outcome)).Observe(duration.Seconds())
}

func (m *Metrics) ObservePublishQueueWait(duration time.Duration, outcome PublishStageOutcome) {
	m.publishQueueWait.WithLabelValues(string(outcome)).Observe(duration.Seconds())
}

func (m *Metrics) ObservePublishChannelAcquisition(duration time.Duration, outcome PublishStageOutcome) {
	m.publishChannelAcquisition.WithLabelValues(string(outcome)).Observe(duration.Seconds())
}

func (m *Metrics) ObservePublishConfirmation(duration time.Duration, outcome PublishConfirmationOutcome) {
	m.publishConfirmation.WithLabelValues(string(outcome)).Observe(duration.Seconds())
}

func (m *Metrics) RecordApplied(outcome AcknowledgementOutcome) {
	m.applied.WithLabelValues(string(outcome)).Inc()
}

func (m *Metrics) RecordDismissed(outcome AcknowledgementOutcome) {
	m.dismissed.WithLabelValues(string(outcome)).Inc()
}

func (m *Metrics) RecordReceivedMessage(outcome AcknowledgementOutcome) {
	m.receivedMessages.WithLabelValues(string(outcome)).Inc()
}

func (m *Metrics) RecordSubscriptionRefusal(reason SubscriptionRefusal) {
	m.subscriptionRefusals.WithLabelValues(string(reason)).Inc()
}

func (m *Metrics) ObserveGroupAuthorization(duration time.Duration, outcome AuthorizationOutcome) {
	m.groupAuthSeconds.WithLabelValues(string(outcome)).Observe(duration.Seconds())
}

func (m *Metrics) RecordReplay(outcome ReplayOutcome) {
	m.replay.WithLabelValues(string(outcome)).Inc()
}

func (m *Metrics) RecordHandshake(outcome HandshakeOutcome) {
	m.handshake.WithLabelValues(string(outcome)).Inc()
}

func (m *Metrics) SetCapacity(resource CapacityResource, limit int) {
	m.capacity.WithLabelValues(string(resource)).Set(float64(limit))
}

func (m *Metrics) RecordFrameError(code protocol.ErrorCode) {
	m.frameErrors.WithLabelValues(string(code)).Inc()
}
