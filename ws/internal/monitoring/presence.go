package monitoring

import "github.com/prometheus/client_golang/prometheus"

type PresenceMetrics struct {
	PresenceWatches    prometheus.Gauge
	PresenceSubjects   prometheus.Gauge
	PresenceEvents     *prometheus.CounterVec
	PresenceResyncs    *prometheus.CounterVec
	PresenceDeliveries prometheus.Counter
}

func newPresenceMetrics(registry *prometheus.Registry) *PresenceMetrics {
	m := &PresenceMetrics{
		PresenceWatches:    prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_presence_watches", Help: "Sockets on this node that watch presence."}),
		PresenceSubjects:   prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_presence_subjects", Help: "Distinct users this node tracks for local watchers."}),
		PresenceEvents:     prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_presence_events_total", Help: "Presence transitions received from Redis, by whether a local socket wanted them."}, []string{"result"}),
		PresenceResyncs:    prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_presence_resyncs_total", Help: "Presence bucket reloads after a lost subscription or sequence gap."}, []string{"reason"}),
		PresenceDeliveries: prometheus.NewCounter(prometheus.CounterOpts{Name: "messenger_ws_presence_deliveries_total", Help: "Presence and online count frames queued to sockets."}),
	}
	registry.MustRegister(m.PresenceWatches, m.PresenceSubjects, m.PresenceEvents, m.PresenceResyncs, m.PresenceDeliveries)
	return m
}
