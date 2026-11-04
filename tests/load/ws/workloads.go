package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

func (work *run) publish(ctx context.Context, socket *client) {
	ticker := time.NewTicker(time.Duration(float64(time.Second) / work.opts.rate))
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if !socket.connected.Load() {
				continue
			}
			if !work.claimMessage() {
				return
			}
			sentAt := time.Now()
			requestID := ulid()
			body := work.prefix + strconv.FormatInt(sentAt.UnixNano(), 10) + "|"
			body += strings.Repeat("x", max(0, work.opts.payloadBytes-len(body)))
			work.trace.recordSend(traceRecord{Kind: "send", Socket: socket.index, RequestID: requestID, SentAt: sentAt, ObservedAt: sentAt}, socket.session.UserID)
			if err := socket.send(map[string]any{"type": "send", "chatId": work.manifest.GroupID, "requestId": requestID, "body": body}); err != nil {
				work.trace.record(traceRecord{Kind: "send_failed", Socket: socket.index, RequestID: requestID, SentAt: sentAt, ObservedAt: time.Now()})
				if work.opts.mode != "reconnect" && work.opts.mode != "drain" {
					work.errors.Add(1)
				}
				continue
			}
			work.sent.Add(1)
		}
	}
}

func (work *run) claimMessage() bool {
	for {
		count := work.attempted.Load()
		if count >= int64(work.opts.maxMessages) {
			return false
		}
		if work.attempted.CompareAndSwap(count, count+1) {
			return true
		}
	}
}

func (work *run) complete() bool {
	if work.mixed != nil {
		return work.mixedComplete()
	}
	if work.queued.Load() != work.sent.Load() {
		return false
	}
	for _, socket := range work.clients {
		if !socket.slow && (!socket.connected.Load() || socket.delivered.Load() < work.sent.Load()) {
			return false
		}
	}
	return true
}

func (work *run) measure(measurement context.Context) error {
	if work.mixed != nil {
		return work.measureMixed(measurement)
	}
	opts := work.opts
	var senders sync.WaitGroup
	if opts.mode != "idle" {
		selected := make(map[string]bool)
		selectedClients := make([]*client, 0, opts.senders)
		for _, socket := range work.clients {
			if socket.slow || selected[socket.session.UserID] {
				continue
			}
			selected[socket.session.UserID] = true
			selectedClients = append(selectedClients, socket)
			if len(selectedClients) == opts.senders {
				break
			}
		}
		if len(selectedClients) != opts.senders {
			return errors.New("not enough distinct healthy sender users")
		}
		for _, socket := range selectedClients {
			senders.Add(1)
			go func() { defer senders.Done(); work.publish(measurement, socket) }()
		}
	}
	var disruption sync.WaitGroup
	if opts.mode == "reconnect" || opts.mode == "drain" {
		disruption.Add(1)
		go func() {
			defer disruption.Done()
			if !wait(measurement, opts.duration/3) {
				return
			}
			if opts.mode == "reconnect" {
				for index, socket := range work.clients {
					if index%2 == 0 {
						socket.interrupt()
					}
				}
			} else if err := work.drain(measurement); err != nil {
				fmt.Fprintln(os.Stderr, err)
				work.errors.Add(1)
			}
		}()
	}
	<-measurement.Done()
	senders.Wait()
	disruption.Wait()
	return nil
}
