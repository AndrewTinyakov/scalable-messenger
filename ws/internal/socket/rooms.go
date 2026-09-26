package socket

import (
	"context"
	"errors"
	"log/slog"
	"math/rand/v2"
	"strconv"
	"strings"
	"sync"
	"time"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type roomMember struct {
	conversationIDs map[string]bool
	catching        bool
	buffer          []protocol.Event
}

type localRoom struct {
	name    string
	ready   chan struct{}
	err     error
	cancel  context.CancelFunc
	members map[*Connection]*roomMember
	epoch   string
	lastID  string
}

type Rooms struct {
	mu            sync.Mutex
	rooms         map[string]*localRoom
	closed        bool
	redis         *redisroom.Client
	logger        *slog.Logger
	replayLimit   int64
	bufferLimit   int
	checkInterval time.Duration
	metrics       *monitoring.Metrics
	wg            sync.WaitGroup
}

func NewRooms(redis *redisroom.Client, logger *slog.Logger, replayLimit int64, bufferLimit int, checkInterval time.Duration, metrics *monitoring.Metrics) *Rooms {
	return &Rooms{rooms: make(map[string]*localRoom), redis: redis, logger: logger, replayLimit: replayLimit, bufferLimit: bufferLimit, checkInterval: checkInterval, metrics: metrics}
}

func (r *Rooms) Join(ctx context.Context, connection *Connection, room, conversationID, epoch, streamID string) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return errors.New("room registry closed")
	}
	entry := r.rooms[room]
	if entry == nil {
		owner, cancel := context.WithCancel(context.Background())
		entry = &localRoom{name: room, ready: make(chan struct{}), cancel: cancel, members: make(map[*Connection]*roomMember)}
		r.rooms[room] = entry
		r.metrics.RoomSubscriptions.Inc()
		r.wg.Add(1)
		go r.listen(owner, entry)
	}
	member := entry.members[connection]
	if member == nil {
		member = &roomMember{conversationIDs: make(map[string]bool)}
		entry.members[connection] = member
	}
	member.conversationIDs[conversationID] = true
	member.catching = true
	r.mu.Unlock()
	select {
	case <-entry.ready:
	case <-ctx.Done():
		r.LeaveConversation(connection, room, conversationID)
		return ctx.Err()
	}
	if entry.err != nil {
		r.LeaveConversation(connection, room, conversationID)
		return entry.err
	}
	var replayEvents []protocol.Event
	if epoch != "" && streamID != "" {
		items, err := r.redis.Replay(ctx, room, epoch, streamID, r.replayLimit)
		if err != nil {
			r.metrics.Replay.WithLabelValues("fallback").Inc()
			r.failMember(connection, room, conversationID)
			r.finish(connection, room, nil)
			return nil
		}
		r.metrics.Replay.WithLabelValues("complete").Inc()
		for _, item := range items {
			if !connection.Enqueue(item.Event) {
				r.Leave(connection, room)
				return errors.New("slow client")
			}
			replayEvents = append(replayEvents, item.Event)
		}
	} else if conversationID != "" {
		// A client with no retained Redis cursor must fetch SQL history.
		r.failMember(connection, room, conversationID)
	}
	r.finish(connection, room, replayEvents)
	return nil
}

func (r *Rooms) listen(ctx context.Context, entry *localRoom) {
	defer r.wg.Done()
	listener, err := r.redis.Subscribe(ctx, entry.name)
	var epoch, last string
	if err == nil {
		epoch, last, err = r.redis.Tail(ctx, entry.name)
	}
	r.mu.Lock()
	entry.err = err
	entry.epoch, entry.lastID = epoch, last
	close(entry.ready)
	r.mu.Unlock()
	if err != nil {
		if listener != nil {
			listener.Close()
		}
		r.logger.Error("subscribe room", "room", entry.name, "error", err)
		return
	}
	defer func() {
		if listener != nil {
			_ = listener.Close()
		}
	}()
	for {
		live, err := listener.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			r.logger.Error("Redis room feed stopped", "room", entry.name, "error", err)
			r.failRoom(entry.name)
			_ = listener.Close()
			for {
				if ctx.Err() != nil {
					return
				}
				timer := time.NewTimer(time.Second)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
				next, subscribeErr := r.redis.Subscribe(ctx, entry.name)
				if subscribeErr != nil {
					continue
				}
				epoch, last, tailErr := r.redis.Tail(ctx, entry.name)
				if tailErr != nil {
					_ = next.Close()
					continue
				}
				listener = next
				r.setPosition(entry.name, epoch, last)
				break
			}
			continue
		}
		r.dispatch(entry.name, live.Event)
	}
}

func (r *Rooms) dispatch(room string, event protocol.Event) {
	r.mu.Lock()
	entry := r.rooms[room]
	if entry == nil {
		r.mu.Unlock()
		return
	}
	var recovery []struct {
		c  *Connection
		id string
	}
	epochChanged := entry.epoch != event.Epoch
	if entry.epoch != "" && event.Epoch != entry.epoch {
		for c, m := range entry.members {
			for id := range m.conversationIDs {
				if id != "" {
					recovery = append(recovery, struct {
						c  *Connection
						id string
					}{c, id})
				}
			}
		}
	}
	if epochChanged || streamAfter(event.StreamID, entry.lastID) {
		entry.lastID = event.StreamID
	}
	entry.epoch = event.Epoch
	var send []*Connection
	var overflow []struct {
		c  *Connection
		id string
	}
	for c, m := range entry.members {
		if m.catching {
			if len(m.buffer) >= r.bufferLimit {
				m.catching = false
				m.buffer = nil
				for id := range m.conversationIDs {
					if id != "" {
						overflow = append(overflow, struct {
							c  *Connection
							id string
						}{c, id})
					}
				}
				continue
			}
			m.buffer = append(m.buffer, event)
		} else {
			send = append(send, c)
		}
	}
	r.mu.Unlock()
	for _, target := range recovery {
		r.failMember(target.c, room, target.id)
	}
	for _, target := range overflow {
		r.failMember(target.c, room, target.id)
	}
	for _, c := range send {
		c.Enqueue(event)
	}
}

func (r *Rooms) finish(c *Connection, room string, replay []protocol.Event) {
	r.mu.Lock()
	entry := r.rooms[room]
	if entry == nil {
		r.mu.Unlock()
		return
	}
	m := entry.members[c]
	if m == nil {
		r.mu.Unlock()
		return
	}
	buffer := m.buffer
	m.buffer = nil
	m.catching = false
	ids := make([]string, 0, len(m.conversationIDs))
	for id := range m.conversationIDs {
		if id != "" {
			ids = append(ids, id)
		}
	}
	r.mu.Unlock()
	seen := make(map[string]bool, len(replay))
	for _, event := range replay {
		seen[event.EventID] = true
	}
	for _, event := range buffer {
		if event.EventID == "" || !seen[event.EventID] {
			c.Enqueue(event)
		}
	}
	for _, id := range ids {
		c.Enqueue(protocol.Event{Type: "subscribed", Version: 1, Room: room, ConversationID: id})
	}
}

func (r *Rooms) failMember(c *Connection, room, conversationID string) {
	r.metrics.SQLFallback.Inc()
	c.Enqueue(protocol.Event{Type: "recovery_failed", Version: 1, Room: room, ConversationID: conversationID})
}

func (r *Rooms) failRoom(room string) {
	r.metrics.StaleRooms.Inc()
	r.mu.Lock()
	entry := r.rooms[room]
	if entry == nil {
		r.mu.Unlock()
		return
	}
	type target struct {
		c  *Connection
		id string
	}
	var targets []target
	for c, m := range entry.members {
		for id := range m.conversationIDs {
			if id != "" {
				targets = append(targets, target{c, id})
			}
		}
	}
	r.mu.Unlock()
	for _, target := range targets {
		r.failMember(target.c, room, target.id)
	}
}

func (r *Rooms) Leave(c *Connection, room string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.rooms[room]
	if entry == nil {
		return
	}
	delete(entry.members, c)
	if len(entry.members) == 0 {
		delete(r.rooms, room)
		r.metrics.RoomSubscriptions.Dec()
		entry.cancel()
	}
}

func (r *Rooms) LeaveConversation(c *Connection, room, conversationID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	entry := r.rooms[room]
	if entry == nil {
		return
	}
	m := entry.members[c]
	if m == nil {
		return
	}
	delete(m.conversationIDs, conversationID)
	if len(m.conversationIDs) == 0 {
		delete(entry.members, c)
	}
	if len(entry.members) == 0 {
		delete(r.rooms, room)
		r.metrics.RoomSubscriptions.Dec()
		entry.cancel()
	}
}

func (r *Rooms) LeaveAll(c *Connection) {
	r.mu.Lock()
	var names []string
	for name, entry := range r.rooms {
		if _, ok := entry.members[c]; ok {
			names = append(names, name)
		}
	}
	r.mu.Unlock()
	for _, name := range names {
		r.Leave(c, name)
	}
}

func (r *Rooms) RunChecks(ctx context.Context) {
	r.wg.Add(1)
	defer r.wg.Done()
	jitter := time.NewTimer(time.Duration(rand.Int64N(int64(r.checkInterval))))
	select {
	case <-ctx.Done():
		jitter.Stop()
		return
	case <-jitter.C:
	}
	ticker := time.NewTicker(r.checkInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			r.checkAll(ctx)
		}
	}
}

func (r *Rooms) checkAll(ctx context.Context) {
	r.mu.Lock()
	names := make([]string, 0, len(r.rooms))
	for name := range r.rooms {
		names = append(names, name)
	}
	r.mu.Unlock()
	for _, name := range names {
		checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
		epoch, last, err := r.redis.Tail(checkCtx, name)
		cancel()
		if err != nil {
			r.failRoom(name)
			continue
		}
		r.mu.Lock()
		entry := r.rooms[name]
		if entry == nil {
			r.mu.Unlock()
			continue
		}
		oldEpoch, oldLast := entry.epoch, entry.lastID
		r.mu.Unlock()
		if oldEpoch != "" && epoch != oldEpoch {
			r.failRoom(name)
			r.setPosition(name, epoch, last)
			continue
		}
		if oldLast == "" && last != "" {
			r.failRoom(name)
			r.setPosition(name, epoch, last)
			continue
		}
		if oldLast != "" && last != oldLast {
			checkCtx, cancel := context.WithTimeout(ctx, 3*time.Second)
			items, replayErr := r.redis.Replay(checkCtx, name, oldEpoch, oldLast, r.replayLimit)
			cancel()
			if replayErr != nil {
				r.failRoom(name)
				r.setPosition(name, epoch, last)
				continue
			}
			for _, item := range items {
				r.dispatch(name, item.Event)
			}
		}
	}
}

func (r *Rooms) setPosition(name, epoch, last string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry := r.rooms[name]; entry != nil {
		entry.epoch = epoch
		entry.lastID = last
	}
}

func streamAfter(candidate, previous string) bool {
	if previous == "" {
		return true
	}
	parse := func(value string) (uint64, uint64, bool) {
		parts := strings.SplitN(value, "-", 2)
		if len(parts) != 2 {
			return 0, 0, false
		}
		a, errA := strconv.ParseUint(parts[0], 10, 64)
		b, errB := strconv.ParseUint(parts[1], 10, 64)
		return a, b, errA == nil && errB == nil
	}
	a, b, okA := parse(candidate)
	x, y, okB := parse(previous)
	if !okA || !okB {
		return candidate != previous
	}
	return a > x || a == x && b > y
}

func (r *Rooms) Close() {
	r.mu.Lock()
	r.closed = true
	for _, entry := range r.rooms {
		entry.cancel()
	}
	r.mu.Unlock()
	r.wg.Wait()
}
