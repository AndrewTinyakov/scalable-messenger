package main

import (
	"bufio"
	"bytes"
	"context"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"strings"
	"time"
)

type nodeMetrics struct {
	name       string
	gauges     map[string]float64
	capacities map[string]float64
}

type metricObserver struct {
	project      string
	baseline     map[string]float64
	afterCleanup map[string]float64
	peak         map[string]float64
	samples      int
	failures     []string
}

var observedGauges = map[string]string{
	"messenger_ws_connections":        "connections",
	"messenger_ws_room_subscriptions": "rooms",
	"messenger_ws_room_memberships":   "memberships",
	"messenger_ws_command_items":      "command_items",
	"messenger_ws_command_bytes":      "command_bytes",
	"messenger_ws_queued_items":       "outbound_items_per_connection",
	"messenger_ws_queued_bytes":       "outbound_bytes_per_connection",
}

func parseMetrics(name string, payload []byte) (nodeMetrics, error) {
	metrics := nodeMetrics{name: name, gauges: make(map[string]float64), capacities: make(map[string]float64)}
	capacity := regexp.MustCompile(`^messenger_ws_capacity\{resource="([^"]+)"\} ([^ ]+)`)
	parse := func(raw string) (float64, error) {
		value, err := strconv.ParseFloat(raw, 64)
		if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
			return 0, fmt.Errorf("gateway %s exported invalid metric value %q", name, raw)
		}
		return value, nil
	}
	scanner := bufio.NewScanner(bytes.NewReader(payload))
	for scanner.Scan() {
		line := scanner.Text()
		if match := capacity.FindStringSubmatch(line); len(match) == 3 {
			value, err := parse(match[2])
			if err != nil {
				return metrics, err
			}
			metrics.capacities[match[1]] = value
			continue
		}
		fields := strings.Fields(line)
		if len(fields) == 2 {
			if _, tracked := observedGauges[fields[0]]; tracked || fields[0] == "process_resident_memory_bytes" || fields[0] == "go_goroutines" {
				value, err := parse(fields[1])
				if err != nil {
					return metrics, err
				}
				metrics.gauges[fields[0]] = value
			}
		}
	}
	return metrics, scanner.Err()
}

func metricTotals(nodes []nodeMetrics) map[string]float64 {
	totals := make(map[string]float64)
	for _, node := range nodes {
		for name, value := range node.gauges {
			totals[name] += value
		}
	}
	return totals
}

func (observer *metricObserver) record(nodes []nodeMetrics) error {
	observer.samples++
	for name, value := range metricTotals(nodes) {
		observer.peak[name] = max(observer.peak[name], value)
	}
	for _, node := range nodes {
		for gauge, resource := range observedGauges {
			value, present := node.gauges[gauge]
			capacity, configured := node.capacities[resource]
			if !present || !configured || capacity <= 0 {
				return fmt.Errorf("gateway %s does not export gauge %s and capacity %s", node.name, gauge, resource)
			}
			if strings.HasPrefix(resource, "outbound_") {
				capacity *= node.capacities["connections"]
			}
			if value < 0 || value > capacity {
				return fmt.Errorf("gateway %s gauge %s=%.0f exceeds bound 0..%.0f", node.name, gauge, value, capacity)
			}
		}
	}
	return nil
}

func (observer *metricObserver) loop(ctx context.Context) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			nodes, err := observer.snapshot(ctx)
			if ctx.Err() != nil {
				return
			}
			if err == nil {
				err = observer.record(nodes)
			}
			if err != nil && len(observer.failures) < 32 {
				observer.failures = append(observer.failures, err.Error())
			}
		}
	}
}

func (observer *metricObserver) verifyCleanup(ctx context.Context) error {
	for ctx.Err() == nil {
		nodes, err := observer.snapshot(ctx)
		if err != nil {
			return err
		}
		if err := observer.record(nodes); err != nil {
			observer.failures = append(observer.failures, err.Error())
			return err
		}
		observer.afterCleanup = metricTotals(nodes)
		clean := true
		for name := range observedGauges {
			if observer.afterCleanup[name] > observer.baseline[name] {
				clean = false
			}
		}
		if clean {
			if len(observer.failures) > 0 {
				return errors.New("metrics observation recorded failures")
			}
			return nil
		}
		if !wait(ctx, 250*time.Millisecond) {
			break
		}
	}
	return errors.New("gateway resources did not return to the baseline before the cleanup deadline")
}
