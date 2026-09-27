package room

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type positionStore struct {
	tail   func(context.Context, string) (string, string, error)
	replay func(context.Context, string, string, string, int64) ([]redisroom.Live, error)
}

func (*positionStore) Subscribe(context.Context, string) (*redisroom.Listener, error) {
	return nil, errors.New("unused")
}
func (store *positionStore) Tail(ctx context.Context, room string) (string, string, error) {
	return store.tail(ctx, room)
}
func (store *positionStore) Replay(ctx context.Context, room, epoch, after string, limit int64) ([]redisroom.Live, error) {
	return store.replay(ctx, room, epoch, after, limit)
}

type positionSink struct {
	mu     sync.Mutex
	events []protocol.Event
}

func (sink *positionSink) Enqueue(event protocol.Event) bool {
	sink.mu.Lock()
	sink.events = append(sink.events, event)
	sink.mu.Unlock()
	return true
}

func newPositionRooms(store *positionStore) *Rooms {
	return &Rooms{rooms: make(map[string]*localRoom), redis: store, replayLimit: 8, metrics: monitoring.New(prometheus.NewRegistry()), logger: slog.New(slog.NewTextHandler(io.Discard, nil))}
}

func addPositionRoom(rooms *Rooms, name string, sink *positionSink) {
	ready := make(chan struct{})
	close(ready)
	member := newRoomMember()
	member.catching.Store(false)
	member.chatIDs["chat"] = true
	rooms.rooms[name] = &localRoom{name: name, ready: ready, epoch: "epoch", lastID: "1-0", members: map[Recipient]*roomMember{sink: member}}
}

func positionLive(id, previous string) redisroom.Live {
	return redisroom.Live{
		Epoch: "epoch", StreamID: id, PreviousStreamID: previous, HasPrevious: true,
		Event: protocol.Event{Type: "message_saved", EventID: id, Epoch: "epoch", StreamID: id, Room: "group:chat", ChatID: "chat"},
	}
}

func TestLiveGapReplaysMissedIntermediateEvent(t *testing.T) {
	store := &positionStore{}
	store.replay = func(_ context.Context, _, _, after string, _ int64) ([]redisroom.Live, error) {
		if after != "1-0" {
			t.Fatalf("replay after = %q, want 1-0", after)
		}
		return []redisroom.Live{positionLive("2-0", "1-0"), positionLive("3-0", "2-0")}, nil
	}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.handleLive(context.Background(), "group:chat", positionLive("3-0", "2-0"))
	if len(sink.events) != 2 || sink.events[0].EventID != "2-0" || sink.events[1].EventID != "3-0" {
		t.Fatalf("events = %+v, want missed then current", sink.events)
	}
	rooms.handleLive(context.Background(), "group:chat", positionLive("2-0", "1-0"))
	if len(sink.events) != 2 {
		t.Fatalf("duplicate live event delivered: %+v", sink.events)
	}
}

func TestLiveGapWithoutRetainedHistoryRequestsSQLRecovery(t *testing.T) {
	store := &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
		return nil, redisroom.ErrGap
	}}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.handleLive(context.Background(), "group:chat", positionLive("3-0", "2-0"))
	if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
		t.Fatalf("events = %+v, want SQL recovery", sink.events)
	}
}

func TestPositionChecksBoundConcurrentRedisReads(t *testing.T) {
	entered := make(chan struct{}, 32)
	release := make(chan struct{})
	store := &positionStore{tail: func(ctx context.Context, _ string) (string, string, error) {
		entered <- struct{}{}
		select {
		case <-release:
			return "epoch", "1-0", nil
		case <-ctx.Done():
			return "", "", ctx.Err()
		}
	}}
	rooms := newPositionRooms(store)
	for i := range 32 {
		addPositionRoom(rooms, "group:"+string(rune('a'+i)), &positionSink{})
	}
	done := make(chan struct{})
	go func() { rooms.checkAll(context.Background()); close(done) }()
	for range 16 {
		select {
		case <-entered:
		case <-time.After(time.Second):
			t.Fatal("did not start 16 bounded checks")
		}
	}
	select {
	case <-entered:
		t.Fatal("started more than 16 checks")
	default:
	}
	close(release)
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("position checks did not finish")
	}
}

func TestPositionCheckSkipsRoomWithRecentLiveEvent(t *testing.T) {
	reads := 0
	store := &positionStore{tail: func(context.Context, string) (string, string, error) {
		reads++
		return "epoch", "1-0", nil
	}}
	rooms := newPositionRooms(store)
	rooms.checkInterval = time.Minute
	addPositionRoom(rooms, "group:chat", &positionSink{})
	rooms.rooms["group:chat"].lastLiveAt = time.Now()
	rooms.checkAll(context.Background())
	if reads != 0 {
		t.Fatalf("Redis tail reads = %d, want 0 for a room with recent live traffic", reads)
	}
}

func TestPositionCheckReplaysMissedFinalEvent(t *testing.T) {
	store := &positionStore{
		tail: func(context.Context, string) (string, string, error) {
			return "epoch", "2-0", nil
		},
		replay: func(_ context.Context, _, _, after string, _ int64) ([]redisroom.Live, error) {
			if after != "1-0" {
				t.Fatalf("replay after = %q, want 1-0", after)
			}
			return []redisroom.Live{positionLive("2-0", "1-0")}, nil
		},
	}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.checkAll(context.Background())
	if len(sink.events) != 1 || sink.events[0].EventID != "2-0" {
		t.Fatalf("events = %+v, want missed final event", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "2-0" {
		t.Fatalf("room position = %q, want 2-0", last)
	}
}

func TestPositionCheckWithoutRetainedHistoryRequestsSQLRecovery(t *testing.T) {
	store := &positionStore{
		tail: func(context.Context, string) (string, string, error) {
			return "epoch", "2-0", nil
		},
		replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
			return nil, redisroom.ErrGap
		},
	}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.checkAll(context.Background())
	if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
		t.Fatalf("events = %+v, want SQL recovery request", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "2-0" {
		t.Fatalf("room position = %q, want 2-0", last)
	}
}

func TestRestoredGroupFeedReplaysMessagesPublishedDuringOutage(t *testing.T) {
	store := &positionStore{replay: func(_ context.Context, _, _, after string, _ int64) ([]redisroom.Live, error) {
		if after != "1-0" {
			t.Fatalf("replay after = %q, want 1-0", after)
		}
		return []redisroom.Live{positionLive("2-0", "1-0"), positionLive("3-0", "2-0")}, nil
	}}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.restorePosition(context.Background(), rooms.rooms["group:chat"], "epoch", "3-0")
	if len(sink.events) != 2 || sink.events[0].EventID != "2-0" || sink.events[1].EventID != "3-0" {
		t.Fatalf("events after feed restoration = %+v, want the complete gap", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "3-0" {
		t.Fatalf("room position = %q, want 3-0", last)
	}
}

func TestRestoredGroupFeedRequestsFreshSQLRecoveryWhenReplayFails(t *testing.T) {
	store := &positionStore{replay: func(context.Context, string, string, string, int64) ([]redisroom.Live, error) {
		return nil, redisroom.ErrGap
	}}
	rooms := newPositionRooms(store)
	sink := &positionSink{}
	addPositionRoom(rooms, "group:chat", sink)
	rooms.restorePosition(context.Background(), rooms.rooms["group:chat"], "epoch", "3-0")
	if len(sink.events) != 1 || sink.events[0].Type != "recovery_failed" {
		t.Fatalf("events after feed restoration = %+v, want a new SQL recovery signal", sink.events)
	}
	if _, _, last := rooms.roomPosition("group:chat"); last != "3-0" {
		t.Fatalf("room position = %q, want 3-0", last)
	}
}

func TestPositionChecksPauseAfterSlowSweep(t *testing.T) {
	const interval = 100 * time.Millisecond
	entered := make(chan int, 2)
	release := make(chan struct{})
	calls := 0
	store := &positionStore{tail: func(ctx context.Context, _ string) (string, string, error) {
		calls++
		entered <- calls
		if calls == 1 {
			select {
			case <-release:
			case <-ctx.Done():
				return "", "", ctx.Err()
			}
		}
		return "epoch", "1-0", nil
	}}
	rooms := newPositionRooms(store)
	rooms.checkInterval = interval
	addPositionRoom(rooms, "user:quiet", &positionSink{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan struct{})
	go func() { rooms.RunChecks(ctx); close(done) }()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("first sweep did not start")
	}
	time.Sleep(2 * interval)
	close(release)
	select {
	case <-entered:
		t.Fatal("second sweep started immediately after an overlong sweep")
	case <-time.After(interval / 3):
	}
	select {
	case <-entered:
	case <-time.After(2 * interval):
		t.Fatal("second sweep did not start after the interval")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("position checker did not stop")
	}
}
