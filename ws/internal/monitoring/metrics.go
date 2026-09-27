package monitoring

import "github.com/prometheus/client_golang/prometheus"

type Metrics struct {
	Connections       prometheus.Gauge
	Handshake         *prometheus.CounterVec
	Applied           *prometheus.CounterVec
	Dismissed         *prometheus.CounterVec
	ReceivedMessages  *prometheus.CounterVec
	FrameErrors       *prometheus.CounterVec
	RecoveryCloses    prometheus.Counter
	GroupLeaseExpired prometheus.Counter
	GroupAuthSeconds  *prometheus.HistogramVec
	RoomSubscriptions prometheus.Gauge
	QueuedBytes       prometheus.Gauge
	SlowCloses        prometheus.Counter
	PublishSeconds    *prometheus.HistogramVec
	Replay            *prometheus.CounterVec
	SQLFallback       prometheus.Counter
	StaleRooms        prometheus.Counter
	PositionSweep     prometheus.Histogram
	OldestPositionAge prometheus.Gauge
	FanoutRecipients  prometheus.Histogram
	FanoutSeconds     prometheus.Histogram
	SavedEventLag     prometheus.Histogram
}

func New(registry *prometheus.Registry) *Metrics {
	m := &Metrics{
		Connections:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_connections", Help: "Active browser WebSocket connections."}),
		Handshake:         prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_handshakes_total", Help: "WebSocket handshake and initial room join outcomes."}, []string{"result"}),
		Applied:           prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_applied_total", Help: "Device-applied acknowledgement outcomes."}, []string{"result"}),
		Dismissed:         prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_dismissed_total", Help: "Explicitly dismissed message interval outcomes."}, []string{"result"}),
		ReceivedMessages:  prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_received_messages_total", Help: "Exact live-message notification receipt outcomes."}, []string{"result"}),
		FrameErrors:       prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_error_frames_total", Help: "Error frames sent to browser clients by bounded reason."}, []string{"code"}),
		RecoveryCloses:    prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_recovery_closes_total", Help: "Sockets closed because the client must recover state."}),
		GroupLeaseExpired: prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_group_lease_expired_total", Help: "Group subscriptions removed when their renewal lease expired."}),
		GroupAuthSeconds:  prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_group_authorization_seconds", Help: "gRPC group subscription authorization latency."}, []string{"result"}),
		RoomSubscriptions: prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_room_subscriptions", Help: "Active room subscriptions on this node."}),
		QueuedBytes:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_queued_bytes", Help: "Bytes in outbound socket queues."}),
		SlowCloses:        prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_slow_closes_total", Help: "Connections closed because their outbound queue filled."}),
		PublishSeconds:    prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_seconds", Help: "RabbitMQ publish latency through broker confirmation."}, []string{"result"}),
		Replay:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_replay_total", Help: "Short Redis history replay outcomes."}, []string{"result"}),
		SQLFallback:       prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_sql_fallback_total", Help: "Client recovery requests requiring SQL history."}),
		StaleRooms:        prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_stale_rooms_total", Help: "Room feeds found stale by Redis errors or position checks."}),
		PositionSweep:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_position_sweep_seconds", Help: "Wall time for one sweep of local room positions.", Buckets: prometheus.ExponentialBuckets(0.01, 2, 14)}),
		OldestPositionAge: prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_oldest_room_position_seconds", Help: "Longest time since an active room's last successful position check or live publication."}),
		FanoutRecipients:  prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_fanout_recipients", Help: "Local recipients considered for each room event.", Buckets: prometheus.ExponentialBuckets(1, 4, 10)}),
		FanoutSeconds:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_fanout_seconds", Help: "Local room-event fanout duration."}),
		SavedEventLag:     prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_saved_event_lag_seconds", Help: "Time from SQL message creation to a live WS room event; includes publisher delay."}),
	}
	registry.MustRegister(m.Connections, m.Handshake, m.Applied, m.Dismissed, m.ReceivedMessages, m.FrameErrors, m.RecoveryCloses, m.GroupLeaseExpired, m.GroupAuthSeconds, m.RoomSubscriptions, m.QueuedBytes, m.SlowCloses, m.PublishSeconds, m.Replay, m.SQLFallback, m.StaleRooms, m.PositionSweep, m.OldestPositionAge, m.FanoutRecipients, m.FanoutSeconds, m.SavedEventLag)
	return m
}
