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

type registryState uint8

const (
	registryOpen registryState = iota
	registryClosed
)

type localRoomState uint8

const (
	roomActive localRoomState = iota
	roomRetired
)

type localRoom struct {
	name           string
	mu             sync.Mutex
	positionMu     sync.Mutex
	ready          chan struct{}
	err            error
	cancel         context.CancelFunc
	state          localRoomState
	members        map[Recipient]*roomMember
	epoch          string
	lastID         string
	lastLiveAt     time.Time
	lastPositionAt time.Time
}

type Rooms struct {
	mu              sync.Mutex
	rooms           map[string]*localRoom
	memberships     map[Recipient]map[string]*localRoom
	membershipCount int
	maxRooms        int
	maxMemberships  int
	state           registryState
	redis           roomStore
	logger          *slog.Logger
	replayLimit     int64
	bufferLimit     int
	bufferBytes     int
	checkInterval   time.Duration
	metrics         *monitoring.Metrics
	staleLog        staleRoomLogLimiter
	wg              sync.WaitGroup
}

var ErrCapacity = errors.New("room capacity reached")
var errMembershipLeft = errors.New("room membership left during join")

type roomStore interface {
	Subscribe(context.Context, string) (roomFeed, error)
	Tail(context.Context, string) (string, string, error)
	Replay(context.Context, string, string, string, int64) ([]redisroom.Live, error)
}

type roomFeed interface {
	Receive(context.Context) (redisroom.Live, error)
	Close() error
}

type redisRoomStore struct{ client *redisroom.Client }

func (store redisRoomStore) Subscribe(ctx context.Context, room string) (roomFeed, error) {
	listener, err := store.client.Subscribe(ctx, room)
	if err != nil {
		return nil, err
	}
	return listener, nil
}

func (store redisRoomStore) Tail(ctx context.Context, room string) (string, string, error) {
	return store.client.Tail(ctx, room)
}

func (store redisRoomStore) TailBatch(ctx context.Context, names []string) (map[string]redisroom.Position, error) {
	return store.client.TailBatch(ctx, names)
}

func (store redisRoomStore) Replay(ctx context.Context, room, epoch, after string, limit int64) ([]redisroom.Live, error) {
	return store.client.Replay(ctx, room, epoch, after, limit)
}

func NewRooms(redis *redisroom.Client, logger *slog.Logger, replayLimit int64, bufferLimit, bufferBytes int, checkInterval time.Duration, metrics *monitoring.Metrics, maxRooms, maxMemberships int) *Rooms {
	rooms := newRooms(redisRoomStore{client: redis}, logger, replayLimit, bufferLimit, bufferBytes, checkInterval, metrics)
	rooms.maxRooms, rooms.maxMemberships = maxRooms, maxMemberships
	return rooms
}

func newRooms(store roomStore, logger *slog.Logger, replayLimit int64, bufferLimit, bufferBytes int, checkInterval time.Duration, metrics *monitoring.Metrics) *Rooms {
	return &Rooms{rooms: make(map[string]*localRoom), memberships: make(map[Recipient]map[string]*localRoom), maxRooms: 100000, maxMemberships: 1000000, redis: store, logger: logger, replayLimit: replayLimit, bufferLimit: bufferLimit, bufferBytes: bufferBytes, checkInterval: checkInterval, metrics: metrics}
}

func (r *Rooms) Join(ctx context.Context, connection Recipient, name, chatID, epoch, streamID string) (joinErr error) {
	started := time.Now()
	result := "complete"
	defer func() {
		if joinErr != nil {
			result = "failed"
		}
		r.metrics.CatchupSeconds.WithLabelValues(result).Observe(time.Since(started).Seconds())
	}()
	if err := ctx.Err(); err != nil {
		return err
	}
	entry, member, err := r.beginJoin(connection, name, chatID)
	if err != nil {
		return err
	}
	defer member.joinMu.Unlock()
	select {
	case <-entry.ready:
	case <-ctx.Done():
		r.leaveMemberChat(connection, entry, member, chatID)
		return ctx.Err()
	}
	entry.mu.Lock()
	feedErr := entry.err
	left := entry.state == roomRetired || entry.members[connection] != member || member.hasLeft()
	entry.mu.Unlock()
	if left {
		return errMembershipLeft
	}
	if feedErr != nil {
		r.leaveMemberChat(connection, entry, member, chatID)
		return feedErr
	}
	var replayEvents []protocol.Event
	if epoch != "" && streamID != "" {
		items, err := r.replay(ctx, name, epoch, streamID, "", "subscribe")
		if err != nil {
			result = "fallback"
		}
		if member.hasLeft() {
			return errMembershipLeft
		}
		if err != nil {
			r.metrics.RecordReplay(monitoring.ReplayFallback)
			r.failMember(connection, name, chatID)
			r.finishMember(connection, entry, member, nil)
			return nil
		}
		r.metrics.RecordReplay(monitoring.ReplayComplete)
		for _, item := range items {
			if member.hasLeft() {
				return errMembershipLeft
			}
			frame, err := protocol.NewEventFrame(item.Event)
			if err != nil || !enqueueFrame(connection, frame) {
				r.leaveMember(connection, entry, member)
				return errors.New("slow client")
			}
			r.metrics.ReplayEvents.Inc()
			r.metrics.ReplayBytes.Add(float64(frame.Size()))
			replayEvents = append(replayEvents, item.Event)
		}
	} else if chatID != "" {
		result = "fallback"
		r.failMember(connection, name, chatID)
	}
	r.finishMember(connection, entry, member, replayEvents)
	if member.hasLeft() {
		return errMembershipLeft
	}
	return nil
}

func (r *Rooms) beginJoin(connection Recipient, name, chatID string) (*localRoom, *roomMember, error) {
	for {
		r.mu.Lock()
		if r.state == registryClosed {
			r.mu.Unlock()
			return nil, nil, errors.New("room registry closed")
		}
		entry := r.rooms[name]
		if entry == nil {
			if len(r.rooms) >= r.maxRooms || r.membershipCount >= r.maxMemberships {
				r.mu.Unlock()
				return nil, nil, ErrCapacity
			}
			owner, cancel := context.WithCancel(context.Background())
			entry = &localRoom{name: name, ready: make(chan struct{}), cancel: cancel, members: make(map[Recipient]*roomMember), lastPositionAt: time.Now()}
			r.rooms[name] = entry
			r.metrics.RoomSubscriptions.Inc()
			r.wg.Add(1)
			go r.listen(owner, entry)
		}
		entry.mu.Lock()
		member := entry.members[connection]
		if member == nil {
			if r.membershipCount >= r.maxMemberships {
				entry.mu.Unlock()
				r.mu.Unlock()
				return nil, nil, ErrCapacity
			}
			member = newRoomMember()
			member.joinMu.Lock()
			entry.members[connection] = member
			if r.memberships[connection] == nil {
				r.memberships[connection] = make(map[string]*localRoom)
			}
			r.memberships[connection][name] = entry
			r.membershipCount++
			r.metrics.RoomMemberships.Inc()
		} else {
			entry.mu.Unlock()
			r.mu.Unlock()
			member.joinMu.Lock()
			r.mu.Lock()
			if r.state == registryClosed || r.rooms[name] != entry {
				r.mu.Unlock()
				member.joinMu.Unlock()
				continue
			}
			entry.mu.Lock()
			if entry.members[connection] != member || member.hasLeft() {
				entry.mu.Unlock()
				r.mu.Unlock()
				member.joinMu.Unlock()
				continue
			}
		}
		member.chatIDs[chatID] = true
		member.beginCatchup()
		entry.mu.Unlock()
		r.mu.Unlock()
		return entry, member, nil
	}
}

func (r *Rooms) lookup(name string) *localRoom {
	r.mu.Lock()
	entry := r.rooms[name]
	r.mu.Unlock()
	return entry
}

func (r *Rooms) Leave(c Recipient, name string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry := r.rooms[name]; entry != nil {
		entry.mu.Lock()
		r.removeMemberLocked(c, entry, entry.members[c])
		entry.mu.Unlock()
	}
}

func (r *Rooms) leaveMember(c Recipient, entry *localRoom, member *roomMember) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rooms[entry.name] != entry {
		return
	}
	entry.mu.Lock()
	if entry.members[c] == member {
		r.removeMemberLocked(c, entry, member)
	}
	entry.mu.Unlock()
}

func (r *Rooms) LeaveChat(c Recipient, name, chatID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if entry := r.rooms[name]; entry != nil {
		entry.mu.Lock()
		r.removeChatLocked(c, entry, entry.members[c], chatID)
		entry.mu.Unlock()
	}
}

func (r *Rooms) leaveMemberChat(c Recipient, entry *localRoom, member *roomMember, chatID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.rooms[entry.name] != entry {
		return
	}
	entry.mu.Lock()
	if entry.members[c] == member {
		r.removeChatLocked(c, entry, member, chatID)
	}
	entry.mu.Unlock()
}

func (r *Rooms) removeChatLocked(c Recipient, entry *localRoom, member *roomMember, chatID string) {
	if member == nil {
		return
	}
	delete(member.chatIDs, chatID)
	if len(member.chatIDs) == 0 {
		r.removeMemberLocked(c, entry, member)
	}
}

func (r *Rooms) removeMemberLocked(c Recipient, entry *localRoom, member *roomMember) {
	if member == nil {
		return
	}
	member.leave()
	delete(entry.members, c)
	if memberships := r.memberships[c]; memberships != nil {
		if memberships[entry.name] == entry {
			delete(memberships, entry.name)
			r.membershipCount--
			r.metrics.RoomMemberships.Dec()
		}
		if len(memberships) == 0 {
			delete(r.memberships, c)
		}
	}
	if len(entry.members) == 0 {
		delete(r.rooms, entry.name)
		entry.state = roomRetired
		r.metrics.RoomSubscriptions.Dec()
		if entry.cancel != nil {
			entry.cancel()
		}
	}
}

func (r *Rooms) LeaveAll(c Recipient) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for name, entry := range r.memberships[c] {
		if r.rooms[name] == entry {
			entry.mu.Lock()
			r.removeMemberLocked(c, entry, entry.members[c])
			entry.mu.Unlock()
		}
	}
}

func (r *Rooms) Close() {
	r.mu.Lock()
	r.state = registryClosed
	for _, entry := range r.rooms {
		entry.mu.Lock()
		entry.state = roomRetired
		for _, member := range entry.members {
			member.leave()
		}
		if entry.cancel != nil {
			entry.cancel()
		}
		entry.mu.Unlock()
	}
	r.metrics.RoomSubscriptions.Sub(float64(len(r.rooms)))
	r.metrics.RoomMemberships.Sub(float64(r.membershipCount))
	clear(r.rooms)
	clear(r.memberships)
	r.membershipCount = 0
	r.mu.Unlock()
	r.wg.Wait()
}
