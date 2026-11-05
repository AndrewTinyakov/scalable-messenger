package monitoring

import (
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/protocol"
)

type FeatureMetrics struct {
	deliveries  *prometheus.CounterVec
	mutationLag prometheus.Histogram
}

func newFeatureMetrics(registry *prometheus.Registry) *FeatureMetrics {
	m := &FeatureMetrics{
		deliveries:  prometheus.NewCounterVec(prometheus.CounterOpts{Name: "messenger_ws_feature_deliveries_total", Help: "Successfully written feature frames by bounded event type."}, []string{"type"}),
		mutationLag: prometheus.NewHistogram(prometheus.HistogramOpts{Name: "messenger_ws_mutation_lag_seconds", Help: "Time from edit or deletion acceptance to successful socket write, including commit and outbox delay.", Buckets: latencyBuckets}),
	}
	registry.MustRegister(m.deliveries, m.mutationLag)
	return m
}

func (m *FeatureMetrics) ObserveFeatureDelivery(event protocol.Event, now time.Time) {
	switch event.Type {
	case protocol.EventMessageChanged, protocol.EventChatDeleted, protocol.EventReadsChanged, protocol.EventHistoryChanged, protocol.EventPresence, protocol.EventChatPreferences, protocol.EventPinsChanged:
		m.deliveries.WithLabelValues(string(event.Type)).Inc()
	default:
		return
	}
	if event.Type != protocol.EventMessageChanged {
		return
	}
	value := event.DeletedAt
	if value == "" {
		value = event.EditedAt
	}
	if changed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		m.mutationLag.Observe(max(0, now.Sub(changed).Seconds()))
	}
}
