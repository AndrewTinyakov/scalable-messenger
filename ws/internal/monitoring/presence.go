package monitoring

import "github.com/prometheus/client_golang/prometheus"

type PresenceMetrics struct {
	PresenceWatches       prometheus.Gauge
	PresenceTargets       prometheus.Gauge
	PresenceReferences    prometheus.Gauge
	PresenceSnapshots     *prometheus.CounterVec
	PresenceQuery         *prometheus.HistogramVec
	PresenceAuthorization *prometheus.HistogramVec
	PresenceStates        *prometheus.CounterVec
	PresenceSweep         prometheus.Histogram
}

func newPresenceMetrics(registry *prometheus.Registry) *PresenceMetrics {
	m := &PresenceMetrics{
		PresenceReferences:    prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_presence_references", Help: "Authorized socket-to-peer watch references before per-node target deduplication."}),
		PresenceWatches:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_presence_watches", Help: "Active authorized presence watch sets on this node."}),
		PresenceTargets:       prometheus.NewGauge(prometheus.GaugeOpts{Name: "messenger_ws_presence_targets", Help: "Distinct watched peers queried once per snapshot sweep."}),
		PresenceSnapshots:     prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_presence_snapshots_total", Help: "Presence batches by bounded result."}, []string{"result"}),
		PresenceQuery:         prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_presence_query_seconds", Help: "Redis presence query time per bounded batch.", Buckets: latencyBuckets}, []string{"result"}),
		PresenceAuthorization: prometheus.NewHistogramVec(prometheus.HistogramOpts{Name: "messenger_ws_presence_authorization_seconds", Help: "Initial and renewal presence authorization duration.", Buckets: latencyBuckets}, []string{"result"}),
		PresenceStates:        prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_presence_states_total", Help: "Peer status changes emitted, excluding freshness heartbeats."}, []string{"state"}),
		PresenceSweep:         prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_presence_sweep_seconds", Help: "Presence scheduling and bounded refresh sweep duration.", Buckets: latencyBuckets}),
	}
	registry.MustRegister(m.PresenceReferences, m.PresenceWatches, m.PresenceTargets, m.PresenceSnapshots, m.PresenceQuery, m.PresenceAuthorization, m.PresenceStates, m.PresenceSweep)
	return m
}
