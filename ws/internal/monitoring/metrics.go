package monitoring

import "github.com/prometheus/client_golang/prometheus"

type Metrics struct {
	Connections       prometheus.Gauge
	RoomSubscriptions prometheus.Gauge
	QueuedBytes       prometheus.Gauge
	SlowCloses        prometheus.Counter
	PublishSeconds    *prometheus.HistogramVec
	Replay            *prometheus.CounterVec
	SQLFallback       prometheus.Counter
	StaleRooms        prometheus.Counter
}

func New(registry *prometheus.Registry) *Metrics {
	m := &Metrics{
		Connections:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_connections", Help: "Active browser WebSocket connections."}),
		RoomSubscriptions: prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_room_subscriptions", Help: "Active room subscriptions on this node."}),
		QueuedBytes:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_queued_bytes", Help: "Bytes in outbound socket queues."}),
		SlowCloses:        prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_slow_closes_total", Help: "Connections closed because their outbound queue filled."}),
		PublishSeconds:    prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_publish_seconds", Help: "RabbitMQ publish latency through broker confirmation."}, []string{"result"}),
		Replay:            prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_replay_total", Help: "Short Redis history replay outcomes."}, []string{"result"}),
		SQLFallback:       prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_sql_fallback_total", Help: "Client recovery requests requiring SQL history."}),
		StaleRooms:        prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_stale_rooms_total", Help: "Room feeds found stale by Redis errors or position checks."}),
	}
	registry.MustRegister(m.Connections, m.RoomSubscriptions, m.QueuedBytes, m.SlowCloses, m.PublishSeconds, m.Replay, m.SQLFallback, m.StaleRooms)
	return m
}
