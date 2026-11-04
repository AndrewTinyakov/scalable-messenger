package main

import (
	"container/heap"
	"context"
	"errors"
	"math/rand"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const mixedQueueCapacity = 256
const mixedMaxWorkers = 16
const mixedMaxSendLag = 250 * time.Millisecond

type mixedSend struct {
	at     time.Duration
	chat   int
	sender int
	bytes  int
}

type mixedClock struct {
	at   time.Duration
	chat int
}

type mixedClocks []mixedClock

func (clocks mixedClocks) Len() int { return len(clocks) }
func (clocks mixedClocks) Less(a, b int) bool {
	if clocks[a].at == clocks[b].at {
		return clocks[a].chat < clocks[b].chat
	}
	return clocks[a].at < clocks[b].at
}
func (clocks mixedClocks) Swap(a, b int)   { clocks[a], clocks[b] = clocks[b], clocks[a] }
func (clocks *mixedClocks) Push(value any) { *clocks = append(*clocks, value.(mixedClock)) }
func (clocks *mixedClocks) Pop() any {
	values := *clocks
	result := values[len(values)-1]
	*clocks = values[:len(values)-1]
	return result
}

func (mixed *mixedWorkload) buildSchedule(duration time.Duration, limit int) ([]mixedSend, error) {
	if duration <= 0 || limit < 1 || limit > 100000 {
		return nil, errors.New("mixed schedules require positive duration and 1-100000 messages")
	}
	rng := rand.New(rand.NewSource(mixed.scenario.Seed ^ 0x5eed1234))
	interval := func(rate float64) time.Duration {
		seconds := rng.ExpFloat64() / rate
		if seconds >= duration.Seconds() {
			return duration
		}
		return max(time.Nanosecond, time.Duration(seconds*float64(time.Second)))
	}
	clocks := make(mixedClocks, 0, len(mixed.chats))
	for index, chat := range mixed.chats {
		clocks = append(clocks, mixedClock{at: interval(chat.rate), chat: index})
	}
	heap.Init(&clocks)
	weight := 0
	for _, payload := range mixed.scenario.Payloads {
		weight += payload.Weight
	}
	schedule := make([]mixedSend, 0, min(limit, 4096))
	for len(clocks) > 0 {
		clock := heap.Pop(&clocks).(mixedClock)
		if clock.at >= duration {
			break
		}
		if len(schedule) == limit {
			return nil, errors.New("seeded schedule exceeds -max-messages; increase the bound or reduce rate/duration")
		}
		chat := mixed.chats[clock.chat]
		payloadChoice := rng.Intn(weight)
		bytes := 0
		for _, payload := range mixed.scenario.Payloads {
			payloadChoice -= payload.Weight
			if payloadChoice < 0 {
				bytes = payload.Bytes
				break
			}
		}
		schedule = append(schedule, mixedSend{at: clock.at, chat: clock.chat, sender: chat.senders[rng.Intn(len(chat.senders))], bytes: bytes})
		clock.at += interval(chat.rate)
		heap.Push(&clocks, clock)
	}
	if len(schedule) == 0 {
		return nil, errors.New("seeded schedule contains no sends; increase duration or rate")
	}
	return schedule, nil
}

func (work *run) measureMixed(ctx context.Context) error {
	mixed := work.mixed
	sockets := make(map[string]*client)
	for _, socket := range work.clients {
		if sockets[socket.session.UserID] == nil {
			sockets[socket.session.UserID] = socket
		}
	}
	queue := make(chan mixedSend, mixedQueueCapacity)
	started := time.Now()
	var workers sync.WaitGroup
	for range min(mixedMaxWorkers, len(sockets)) {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for send := range queue {
				if ctx.Err() != nil {
					mixed.cancelled.Add(1)
					continue
				}
				work.publishMixed(ctx, started, sockets[mixed.users[send.sender].UserID], send)
			}
		}()
	}
	for index, send := range mixed.schedule {
		delay := time.Until(started.Add(send.at))
		if delay > 0 && !wait(ctx, delay) {
			mixed.cancelled.Add(int64(len(mixed.schedule) - index))
			break
		}
		if ctx.Err() != nil {
			mixed.cancelled.Add(int64(len(mixed.schedule) - index))
			break
		}
		select {
		case queue <- send:
			mixed.dispatched.Add(1)
		default:
			mixed.queueDropped.Add(1)
		}
	}
	close(queue)
	workers.Wait()
	<-ctx.Done()
	if mixed.queueDropped.Load()+mixed.lateDropped.Load()+mixed.cancelled.Load() > 0 {
		work.errors.Add(1)
	}
	return nil
}

func (work *run) publishMixed(ctx context.Context, started time.Time, socket *client, send mixedSend) {
	if !work.claimMessage() {
		work.errors.Add(1)
		return
	}
	waiting := time.Now()
	socket.mu.Lock()
	defer socket.mu.Unlock()
	sentAt := time.Now()
	lag := sentAt.Sub(started) - send.at
	recordMixedMaximum(&work.mixed.maxWriteWait, sentAt.Sub(waiting))
	recordMixedMaximum(&work.mixed.maxLag, lag)
	if ctx.Err() != nil {
		work.mixed.cancelled.Add(1)
		return
	}
	if lag > mixedMaxSendLag {
		work.mixed.lateDropped.Add(1)
		return
	}
	requestID := ulid()
	body := work.prefix + strconv.FormatInt(sentAt.UnixNano(), 10) + "|"
	body += strings.Repeat("x", max(0, send.bytes-len(body)))
	chat := work.mixed.chats[send.chat]
	work.trace.recordSend(traceRecord{Kind: "send", Socket: socket.index, RequestID: requestID, SentAt: sentAt, ObservedAt: sentAt}, socket.session.UserID)
	if err := socket.writeLocked(map[string]any{"type": "send", "chatId": chat.id, "requestId": requestID, "body": body}); err != nil {
		work.trace.record(traceRecord{Kind: "send_failed", Socket: socket.index, RequestID: requestID, SentAt: sentAt, ObservedAt: time.Now()})
		work.errors.Add(1)
		return
	}
	chat.sent.Add(1)
	work.sent.Add(1)
}

func (work *run) mixedComplete() bool {
	if work.queued.Load() != work.sent.Load() {
		return false
	}
	for _, socket := range work.clients {
		if !socket.connected.Load() {
			return false
		}
		for _, progress := range socket.chats {
			if progress.delivered.Load() != progress.chat.sent.Load() {
				return false
			}
		}
	}
	return true
}

func recordMixedMaximum(counter *atomic.Int64, value time.Duration) {
	for previous := counter.Load(); value.Nanoseconds() > previous; previous = counter.Load() {
		if counter.CompareAndSwap(previous, value.Nanoseconds()) {
			return
		}
	}
}
