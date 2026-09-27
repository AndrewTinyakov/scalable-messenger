package room

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type localRoom struct {
	name           string
	positionMu     sync.Mutex
	ready          chan struct{}
	err            error
	cancel         context.CancelFunc
	members        map[Recipient]*roomMember
	epoch          string
	lastID         string
	lastLiveAt     time.Time
	lastPositionAt time.Time
}

type Rooms struct {
	mu            sync.Mutex
	rooms         map[string]*localRoom
	closed        bool
	redis         roomStore
	logger        *slog.Logger
	replayLimit   int64
	bufferLimit   int
	checkInterval time.Duration
	metrics       *monitoring.Metrics
	wg            sync.WaitGroup
}

type roomStore interface {
	Subscribe(context.Context, string) (*redisroom.Listener, error)
	Tail(context.Context, string) (string, string, error)
	Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error)
}

func NewRooms(redis *redisroom.Client, logger *slog.Logger, replayLimit int64, bufferLimit int, checkInterval time.Duration, metrics *monitoring.Metrics) *Rooms {
	return &Rooms{rooms: make(map[string]*localRoom), redis: redis, logger: logger, replayLimit: replayLimit, bufferLimit: bufferLimit, checkInterval: checkInterval, metrics: metrics}
}

func (r *Rooms) Join(ctx context.Context, connection Recipient, room, chatID, epoch, streamID string) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return errors.New("room registry closed")
	}
	entry := r.rooms[room]
	if entry == nil {
		owner, cancel := context.WithCancel(context.Background())
		entry = &localRoom{name: room, ready: make(chan struct{}), cancel: cancel, members: make(map[Recipient]*roomMember), lastPositionAt: time.Now()}
		r.rooms[room] = entry
		r.metrics.RoomSubscriptions.Inc()
		r.wg.Add(1)
		go r.listen(owner, entry)
	}
	member := entry.members[connection]
	if member == nil {
		member = newRoomMember()
		entry.members[connection] = member
	}
	member.chatIDs[chatID] = true
	member.catching.Store(true)
	r.mu.Unlock()
	select {
	case <-entry.ready:
	case <-ctx.Done():
		r.LeaveChat(connection, room, chatID)
		return ctx.Err()
	}
	if entry.err != nil {
		r.LeaveChat(connection, room, chatID)
		return entry.err
	}
	var replayEvents []protocol.Event
	if epoch != "" && streamID != "" {
		items, err := r.redis.Replay(ctx, room, epoch, streamID, r.replayLimit)
		if err != nil {
			r.metrics.Replay.WithLabelValues("fallback").Inc()
			r.failMember(connection, room, chatID)
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
	} else if chatID != "" {
		// A client with no retained Redis cursor must fetch SQL history.
		r.failMember(connection, room, chatID)
	}
	r.finish(connection, room, replayEvents)
	return nil
}

func (r *Rooms) Leave(c Recipient, room string) {
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

func (r *Rooms) LeaveChat(c Recipient, room, chatID string) {
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
	delete(m.chatIDs, chatID)
	if len(m.chatIDs) == 0 {
		delete(entry.members, c)
	}
	if len(entry.members) == 0 {
		delete(r.rooms, room)
		r.metrics.RoomSubscriptions.Dec()
		entry.cancel()
	}
}

func (r *Rooms) LeaveAll(c Recipient) {
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

func (r *Rooms) Close() {
	r.mu.Lock()
	r.closed = true
	for _, entry := range r.rooms {
		entry.cancel()
	}
	r.mu.Unlock()
	r.wg.Wait()
}
