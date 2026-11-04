package main

import (
	"context"
	"errors"
	"fmt"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

func (work *run) drain(ctx context.Context) error {
	if !regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*$`).MatchString(work.opts.drainContainer) {
		return errors.New("invalid drain container name")
	}
	inspect, err := exec.CommandContext(ctx, "docker", "inspect", "--format", `{{index .Config.Labels "com.docker.compose.project"}}|{{index .Config.Labels "com.docker.compose.service"}}`, work.opts.drainContainer).Output()
	if err != nil {
		return err
	}
	if strings.TrimSpace(string(inspect)) != work.opts.composeProject+"|ws" {
		return errors.New("drain container does not belong to the specified Compose project's ws service")
	}
	return exec.CommandContext(ctx, "docker", "stop", "--time", "20", work.opts.drainContainer).Run()
}

func (observer *metricObserver) snapshot(ctx context.Context) ([]nodeMetrics, error) {
	requestCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	ids, err := exec.CommandContext(requestCtx, "docker", "ps", "--filter", "label=com.docker.compose.project="+observer.project, "--filter", "label=com.docker.compose.service=ws", "--format", "{{.ID}}").Output()
	if err != nil {
		return nil, err
	}
	names := strings.Fields(string(ids))
	if len(names) == 0 || len(names) > 256 {
		return nil, fmt.Errorf("metrics observation needs 1 to 256 running gateways, found %d", len(names))
	}
	type result struct {
		metrics nodeMetrics
		err     error
	}
	results := make(chan result, len(names))
	jobs := make(chan string)
	var workers sync.WaitGroup
	for range min(8, len(names)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for name := range jobs {
				payload, err := exec.CommandContext(requestCtx, "docker", "exec", name, "wget", "-T", "3", "-q", "-O", "-", "http://127.0.0.1:8081/metrics").Output()
				if err != nil {
					state, inspectErr := exec.CommandContext(requestCtx, "docker", "inspect", "--format", "{{.State.Running}}", name).Output()
					if inspectErr == nil && strings.TrimSpace(string(state)) == "false" {
						continue
					}
					results <- result{err: fmt.Errorf("sample gateway %s: %w", name, err)}
					continue
				}
				metrics, err := parseMetrics(name, payload)
				results <- result{metrics: metrics, err: err}
			}
		}()
	}
	for _, name := range names {
		jobs <- name
	}
	close(jobs)
	workers.Wait()
	close(results)
	nodes := make([]nodeMetrics, 0, len(names))
	for result := range results {
		if result.err != nil {
			return nil, result.err
		}
		nodes = append(nodes, result.metrics)
	}
	if len(nodes) == 0 {
		return nil, errors.New("no gateway metrics remained available")
	}
	return nodes, nil
}
