package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"time"
)

const traceQueueCapacity = 1024
const traceMaxRecords = 100000
const traceMaxSendKeys = 100000

type traceRecord struct {
	Kind         string    `json:"kind"`
	Socket       int       `json:"socket"`
	RequestID    string    `json:"requestId"`
	EventID      string    `json:"eventId,omitempty"`
	Sequence     string    `json:"sequence,omitempty"`
	SentAt       time.Time `json:"sentAt,omitzero"`
	CreatedAt    string    `json:"createdAt,omitempty"`
	ObservedAt   time.Time `json:"observedAt"`
	ElapsedNanos int64     `json:"elapsedNanos"`
	Source       string    `json:"source,omitempty"`
}

type traceSendKey struct {
	sentAtNanos int64
	senderID    string
}

type traceSend struct {
	requestID string
	ambiguous bool
}

type latencyTrace struct {
	mu                       sync.Mutex
	closeOnce                sync.Once
	queue                    chan traceRecord
	done                     chan struct{}
	started                  time.Time
	sampleEvery              int
	maxRecords               int64
	submitted                int64
	written                  int64
	queueDropped             int64
	limitDropped             int64
	missingRequestIDs        int64
	sendIndex                map[traceSendKey]traceSend
	maxSendKeys              int
	sendIndexOverflow        int64
	sendIndexCollisions      int64
	invalidSendMetadata      int64
	invalidRecoveryMetadata  int64
	recoveryCorrelated       int64
	recoverySkippedUnsampled int64
	recoveryUnmatched        int64
	recoveryAmbiguous        int64
	closedDropped            int64
	closed                   bool
	writeError               error
}

func openLatencyTrace(path string, sampleEvery int) (*latencyTrace, error) {
	if sampleEvery < 1 {
		return nil, errors.New("trace sample interval must be positive")
	}
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return nil, err
	}
	return startLatencyTrace(file, sampleEvery, traceQueueCapacity, traceMaxRecords), nil
}

func startLatencyTrace(writer io.WriteCloser, sampleEvery, capacity int, maxRecords int64) *latencyTrace {
	trace := &latencyTrace{queue: make(chan traceRecord, capacity), done: make(chan struct{}), started: time.Now(), sampleEvery: sampleEvery, maxRecords: maxRecords, maxSendKeys: traceMaxSendKeys, sendIndex: make(map[traceSendKey]traceSend)}
	go trace.write(writer)
	return trace
}

func (trace *latencyTrace) sampled(requestID string) bool {
	if requestID == "" {
		return false
	}
	hash := uint64(14695981039346656037)
	for index := range len(requestID) {
		hash = (hash ^ uint64(requestID[index])) * 1099511628211
	}
	return hash%uint64(trace.sampleEvery) == 0
}

func (trace *latencyTrace) record(record traceRecord) {
	if trace == nil {
		return
	}
	trace.mu.Lock()
	defer trace.mu.Unlock()
	trace.recordLocked(record)
}

func (trace *latencyTrace) recordSend(record traceRecord, senderID string) {
	if trace == nil {
		return
	}
	trace.mu.Lock()
	defer trace.mu.Unlock()
	if !trace.closed && record.RequestID != "" {
		if senderID == "" || len(senderID) > 128 || len(record.RequestID) > 128 || record.SentAt.IsZero() {
			trace.invalidSendMetadata++
		} else {
			key := traceSendKey{sentAtNanos: record.SentAt.UnixNano(), senderID: senderID}
			if previous, exists := trace.sendIndex[key]; exists {
				previous.ambiguous = true
				trace.sendIndex[key] = previous
				trace.sendIndexCollisions++
			} else if len(trace.sendIndex) >= trace.maxSendKeys {
				trace.sendIndexOverflow++
			} else {
				metadata := traceSend{}
				if trace.sampled(record.RequestID) {
					metadata.requestID = strings.Clone(record.RequestID)
				}
				key.senderID = strings.Clone(senderID)
				trace.sendIndex[key] = metadata
			}
		}
	}
	trace.recordLocked(record)
}

func (trace *latencyTrace) recordRecovery(record traceRecord, senderID string) {
	if trace == nil {
		return
	}
	if record.RequestID != "" {
		trace.record(record)
		return
	}
	trace.mu.Lock()
	defer trace.mu.Unlock()
	if senderID == "" || len(senderID) > 128 || record.SentAt.IsZero() {
		trace.invalidRecoveryMetadata++
		return
	}
	metadata, exists := trace.sendIndex[traceSendKey{sentAtNanos: record.SentAt.UnixNano(), senderID: senderID}]
	if !exists {
		trace.recoveryUnmatched++
		return
	}
	if metadata.ambiguous {
		trace.recoveryAmbiguous++
		return
	}
	if metadata.requestID == "" {
		trace.recoverySkippedUnsampled++
		return
	}
	record.RequestID = metadata.requestID
	trace.recoveryCorrelated++
	trace.recordLocked(record)
}

func (trace *latencyTrace) recordLocked(record traceRecord) {
	if record.RequestID == "" {
		trace.missingRequestIDs++
		return
	}
	if !trace.sampled(record.RequestID) {
		return
	}
	if trace.closed {
		trace.closedDropped++
		return
	}
	if trace.submitted >= trace.maxRecords {
		trace.limitDropped++
		return
	}
	record.RequestID = strings.Clone(record.RequestID[:min(len(record.RequestID), 128)])
	record.EventID = strings.Clone(record.EventID[:min(len(record.EventID), 128)])
	record.Sequence = strings.Clone(record.Sequence[:min(len(record.Sequence), 32)])
	record.CreatedAt = strings.Clone(record.CreatedAt[:min(len(record.CreatedAt), 128)])
	record.ElapsedNanos = record.ObservedAt.Sub(trace.started).Nanoseconds()
	select {
	case trace.queue <- record:
		trace.submitted++
	default:
		trace.queueDropped++
	}
}

func (trace *latencyTrace) write(writer io.WriteCloser) {
	defer close(trace.done)
	buffer := bufio.NewWriterSize(writer, 64<<10)
	encoder := json.NewEncoder(buffer)
	var writeError error
	var written int64
	for record := range trace.queue {
		if writeError == nil {
			writeError = encoder.Encode(record)
			if writeError == nil {
				written++
			}
		}
	}
	writeError = errors.Join(writeError, buffer.Flush(), writer.Close())
	trace.mu.Lock()
	trace.written, trace.writeError = written, writeError
	trace.mu.Unlock()
}

func (trace *latencyTrace) close() {
	if trace == nil {
		return
	}
	trace.closeOnce.Do(func() {
		trace.mu.Lock()
		trace.closed = true
		close(trace.queue)
		trace.mu.Unlock()
		<-trace.done
	})
}

func (trace *latencyTrace) complete() bool {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	return trace.closed && trace.queueDropped == 0 && trace.limitDropped == 0 && trace.closedDropped == 0 && trace.missingRequestIDs == 0 && trace.sendIndexOverflow == 0 && trace.sendIndexCollisions == 0 && trace.invalidSendMetadata == 0 && trace.invalidRecoveryMetadata == 0 && trace.recoveryUnmatched == 0 && trace.recoveryAmbiguous == 0 && trace.writeError == nil
}

func (trace *latencyTrace) report() map[string]any {
	trace.mu.Lock()
	defer trace.mu.Unlock()
	writeError := ""
	if trace.writeError != nil {
		writeError = trace.writeError.Error()
	}
	return map[string]any{"sampleEvery": trace.sampleEvery, "maxRecords": trace.maxRecords, "queueCapacity": cap(trace.queue), "submitted": trace.submitted, "written": trace.written, "queueDropped": trace.queueDropped, "limitDropped": trace.limitDropped, "closedDropped": trace.closedDropped, "missingRequestIDs": trace.missingRequestIDs, "sendIndexEntries": len(trace.sendIndex), "maxSendKeys": trace.maxSendKeys, "sendIndexOverflow": trace.sendIndexOverflow, "sendIndexCollisions": trace.sendIndexCollisions, "invalidSendMetadata": trace.invalidSendMetadata, "invalidRecoveryMetadata": trace.invalidRecoveryMetadata, "recoveryCorrelated": trace.recoveryCorrelated, "recoverySkippedUnsampled": trace.recoverySkippedUnsampled, "recoveryUnmatched": trace.recoveryUnmatched, "recoveryAmbiguous": trace.recoveryAmbiguous, "writeError": writeError}
}
