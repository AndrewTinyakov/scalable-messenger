package monitoring

import (
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	dto "github.com/prometheus/client_model/go"
)

func TestHandshakeSetupFinishesOnceAndBoundsLabels(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewHandshakeMetrics(registry)
	setup := metrics.BeginHandshake()
	setup.started = time.Now().Add(-time.Second)
	setup.stageStarted = setup.started
	setup.NextStage(HandshakeStage("private-room-name"))
	setup.Finish(HandshakeOutcome("raw dependency failure"))
	setup.Finish(HandshakeAccepted)
	setup.NextStage(HandshakeSessionValidation)
	setup.CompleteStage()

	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		switch family.GetName() {
		case "messenger_ws_handshake_setup_seconds":
			if len(family.Metric) != 1 {
				t.Fatalf("setup series = %d, want 1", len(family.Metric))
			}
			metric := family.Metric[0]
			if metric.Label[0].GetValue() != "other" || metric.Histogram.GetSampleCount() != 1 || metric.Histogram.GetSampleSum() < 1 {
				t.Fatalf("setup histogram = %v", metric)
			}
		case "messenger_ws_handshake_stage_seconds":
			if len(family.Metric) != 2 {
				t.Fatalf("stage series = %d, want 2", len(family.Metric))
			}
			for _, metric := range family.Metric {
				labels := handshakeTestLabels(metric)
				if (labels["stage"] != "admission" || labels["result"] != "ready") && (labels["stage"] != "other" || labels["result"] != "other") {
					t.Fatalf("stage labels = %v", labels)
				}
				if metric.Histogram.GetSampleCount() != 1 {
					t.Fatalf("stage histogram = %v", metric)
				}
			}
		}
	}
}

func TestCompletedHandshakeStageIsNotObservedAgainAtFinish(t *testing.T) {
	registry := prometheus.NewRegistry()
	metrics := NewHandshakeMetrics(registry)
	setup := metrics.BeginHandshake()
	setup.CompleteStage()
	setup.Finish(HandshakeSetupCanceled)
	families, err := registry.Gather()
	if err != nil {
		t.Fatal(err)
	}
	for _, family := range families {
		if len(family.Metric) != 1 || family.Metric[0].Histogram.GetSampleCount() != 1 {
			t.Fatalf("histogram family = %v", family)
		}
	}
}

func handshakeTestLabels(metric *dto.Metric) map[string]string {
	labels := make(map[string]string)
	for _, label := range metric.Label {
		labels[label.GetName()] = label.GetValue()
	}
	return labels
}
