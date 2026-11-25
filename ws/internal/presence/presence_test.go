package presence

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"strconv"
	"sync"
	"testing"
	"time"

	"github.com/prometheus/client_golang/prometheus"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
	"messenger/ws/internal/roomname"
)

type fakeStore struct {
	mu         sync.Mutex
	states     map[string]redisroom.PresenceState
	sequences  map[int]int64
	feeds      map[int][]chan redisroom.Live
	subscribes int
	writes     []map[string]bool
	writeErr   error
}

func newFakeStore() *fakeStore {
	return &fakeStore{states: make(map[string]redisroom.PresenceState), sequences: make(map[int]int64), feeds: make(map[int][]chan redisroom.Live)}
}

func (s *fakeStore) SetPresence(_ context.Context, _ string, active map[string]bool) map[string]error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.writes = append(s.writes, active)
	failed := make(map[string]error)
	for id := range active {
		if s.writeErr != nil {
			failed[id] = s.writeErr
		}
	}
	return failed
}

func (s *fakeStore) PresenceSnapshot(_ context.Context, ids []string) (map[string]redisroom.PresenceState, map[int]int64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	states := make(map[string]redisroom.PresenceState, len(ids))
	sequences := make(map[int]int64)
	for _, id := range ids {
		states[id] = s.states[id]
		bucket := roomname.PresenceBucketOf(id)
		sequences[bucket] = s.sequences[bucket]
	}
	return states, sequences, nil
}

func (s *fakeStore) PresenceGatewayUsers(_ context.Context, _ string, _ uint64) ([]string, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var users []string
	for _, write := range s.writes {
		for id, on := range write {
			if on {
				users = append(users, id)
			}
		}
	}
	return users, 0, nil
}

func (s *fakeStore) ForgetPresenceGateway(context.Context, string) error { return nil }

func (s *fakeStore) SubscribePresence(ctx context.Context, bucket int) (Feed, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.subscribes++
	feed := make(chan redisroom.Live, 16)
	s.feeds[bucket] = append(s.feeds[bucket], feed)
	return fakeFeed(feed), nil
}

// publish changes a user's state the way the Redis script does.
func (s *fakeStore) publish(userID string, online bool, seqStep int64) {
	s.mu.Lock()
	bucket := roomname.PresenceBucketOf(userID)
	state := s.states[userID]
	state.Online, state.Version = online, state.Version+1
	if !online {
		state.LastSeen = time.Now().UnixMilli()
	}
	s.states[userID] = state
	s.sequences[bucket] += seqStep
	payload, _ := json.Marshal(transition{UserID: userID, Version: strconv.FormatInt(state.Version, 10), Seq: s.sequences[bucket], Online: online, LastSeen: state.LastSeen})
	feeds := append([]chan redisroom.Live(nil), s.feeds[bucket]...)
	s.mu.Unlock()
	for _, feed := range feeds {
		feed <- redisroom.Live{Raw: string(payload)}
	}
}

type fakeFeed chan redisroom.Live

func (f fakeFeed) Receive(ctx context.Context) (redisroom.Live, error) {
	select {
	case live := <-f:
		return live, nil
	case <-ctx.Done():
		return redisroom.Live{}, ctx.Err()
	}
}
func (fakeFeed) Close() error { return nil }

type fakeAuth struct {
	mu      sync.Mutex
	levels  map[string]grpcauth.PresenceLevel
	members map[string][]string
	calls   [][]string
}

func (a *fakeAuth) PresenceVisibility(_ context.Context, _ string, ids []string) (map[string]grpcauth.Visibility, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.calls = append(a.calls, append([]string(nil), ids...))
	result := make(map[string]grpcauth.Visibility, len(ids))
	for _, id := range ids {
		level, ok := a.levels[id]
		if !ok {
			level = grpcauth.PresenceFull
		}
		result[id] = grpcauth.Visibility{Level: level}
	}
	return result, nil
}

func (a *fakeAuth) OnlineCountMembers(_ context.Context, _, chatID string, limit int) (int, []string, error) {
	a.mu.Lock()
	defer a.mu.Unlock()
	members := a.members[chatID]
	if len(members) > limit {
		return len(members), nil, nil
	}
	return len(members), members, nil
}

type fakeWatcher struct {
	events chan protocol.Event
}

func newFakeWatcher() *fakeWatcher { return &fakeWatcher{events: make(chan protocol.Event, 64)} }

func (w *fakeWatcher) Enqueue(event protocol.Event) bool { w.events <- event; return true }
func (*fakeWatcher) PresenceSession() string             { return "session" }
func (*fakeWatcher) Closed() bool                        { return false }

func (w *fakeWatcher) next(t *testing.T) protocol.Event {
	t.Helper()
	select {
	case event := <-w.events:
		return event
	case <-time.After(2 * time.Second):
		t.Fatal("no presence event")
		return protocol.Event{}
	}
}

func (w *fakeWatcher) quiet(t *testing.T) {
	t.Helper()
	select {
	case event := <-w.events:
		t.Fatalf("unexpected event %+v", event)
	case <-time.After(150 * time.Millisecond):
	}
}

func testConfig() Config {
	config := DefaultConfig()
	config.FlushInterval = 10 * time.Millisecond
	config.Grace = 50 * time.Millisecond
	return config
}

func startHub(t *testing.T, store *fakeStore, auth *fakeAuth, config Config) *Hub {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	hub := NewHub(ctx, store, auth, config, slog.New(slog.NewTextHandler(io.Discard, nil)), monitoring.New(prometheus.NewRegistry()).PresenceMetrics)
	done := make(chan struct{})
	go func() { hub.Run(ctx); close(done) }()
	t.Cleanup(func() { cancel(); <-done })
	time.Sleep(5 * time.Millisecond)
	return hub
}

func user(i int) string { return fmt.Sprintf("%026d", i) }

func TestHubSharesSubjectsAndPushesOnlyTransitions(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	store.states[alice] = redisroom.PresenceState{Online: true, Version: 1}
	hub := startHub(t, store, auth, testConfig())
	bob, carol := newFakeWatcher(), newFakeWatcher()
	for _, w := range []*fakeWatcher{bob, carol} {
		if err := hub.Watch(context.Background(), w, []string{alice}, nil, false); err != nil {
			t.Fatal(err)
		}
		if event := w.next(t); len(event.Statuses) != 1 || !event.Statuses[0].Online {
			t.Fatalf("snapshot = %+v", event)
		}
	}
	if store.subscribes != 1 {
		t.Fatalf("subscriptions = %d, want 1 shared", store.subscribes)
	}
	bob.quiet(t)
	store.publish(alice, false, 1)
	for _, w := range []*fakeWatcher{bob, carol} {
		event := w.next(t)
		if len(event.Statuses) != 1 || event.Statuses[0].Online || event.Statuses[0].LastSeenAt == "" {
			t.Fatalf("offline transition = %+v", event)
		}
	}
}

func TestHubHidesUnauthorizedAndCoarseDetails(t *testing.T) {
	store := newFakeStore()
	stranger, private := user(1), user(2)
	store.states[private] = redisroom.PresenceState{Online: true, Version: 1}
	auth := &fakeAuth{levels: map[string]grpcauth.PresenceLevel{stranger: grpcauth.PresenceNone, private: grpcauth.PresenceCoarse}}
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{stranger, private}, nil, false); err != nil {
		t.Fatal(err)
	}
	event := bob.next(t)
	if len(event.Unavailable) != 1 || event.Unavailable[0] != stranger {
		t.Fatalf("unavailable = %v", event.Unavailable)
	}
	if len(event.Statuses) != 1 || event.Statuses[0].Online || event.Statuses[0].LastSeen != "recently" || event.Statuses[0].LastSeenAt != "" {
		t.Fatalf("coarse status = %+v", event.Statuses)
	}
}

func TestHubAuthorizesOnlyAddedUsersAndEnforcesCap(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	config := testConfig()
	config.MaxWatched = 2
	hub := startHub(t, store, auth, config)
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{user(1), user(2)}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	if err := hub.Watch(context.Background(), bob, []string{user(1), user(3)}, nil, false); err != nil {
		t.Fatal(err)
	}
	if event := bob.next(t); len(event.Unavailable) != 1 || event.Unavailable[0] != user(3) {
		t.Fatalf("over cap = %+v", event)
	}
	if err := hub.Watch(context.Background(), bob, []string{user(3)}, []string{user(2)}, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	auth.mu.Lock()
	defer auth.mu.Unlock()
	if len(auth.calls) != 2 || len(auth.calls[1]) != 1 || auth.calls[1][0] != user(3) {
		t.Fatalf("authorization calls = %v, want only new users", auth.calls)
	}
}

func TestHubPausesHiddenWatchersAndResyncsGaps(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	hub.SetVisible(bob, false)
	store.publish(alice, true, 1)
	bob.quiet(t)
	hub.SetVisible(bob, true)
	if event := bob.next(t); !event.Statuses[0].Online {
		t.Fatalf("catch-up = %+v", event)
	}
	store.mu.Lock()
	state := store.states[alice]
	state.Online, state.Version = false, state.Version+5
	store.states[alice] = state
	store.mu.Unlock()
	neighbour := 2
	for roomname.PresenceBucketOf(user(neighbour)) != roomname.PresenceBucketOf(alice) {
		neighbour++
	}
	store.publish(user(neighbour), true, 3)
	if event := bob.next(t); event.Statuses[0].Online {
		t.Fatalf("gap was not resynced: %+v", event)
	}
}

func TestHubSendsOnlineCountForSmallGroups(t *testing.T) {
	store := newFakeStore()
	members := []string{user(1), user(2), user(3)}
	store.states[user(1)] = redisroom.PresenceState{Online: true, Version: 1}
	auth := &fakeAuth{members: map[string][]string{"small": members, "large": append(members, user(4))}}
	config := testConfig()
	config.MaxCountGroup = 3
	hub := startHub(t, store, auth, config)
	bob := newFakeWatcher()
	if err := hub.WatchOnlineCount(context.Background(), bob, "small"); err != nil {
		t.Fatal(err)
	}
	if event := bob.next(t); event.Type != protocol.EventOnlineCount || event.Online != 1 || event.Members != 3 {
		t.Fatalf("count = %+v", event)
	}
	store.publish(user(2), true, 1)
	if event := bob.next(t); event.Online != 2 {
		t.Fatalf("count after transition = %+v", event)
	}
	if err := hub.WatchOnlineCount(context.Background(), bob, "large"); err != nil {
		t.Fatal(err)
	}
	bob.quiet(t)
}

func TestTrackerWritesOnlyAfterGrace(t *testing.T) {
	store := newFakeStore()
	tracker := NewTracker(store, recorderFunc(func(context.Context, []grpcauth.LastSeen) error { return nil }), func() string { return "gateway" }, testConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go tracker.Run(ctx)
	alice := user(1)
	tracker.SetActive(alice, true)
	tracker.SetActive(alice, true)
	waitWrites(t, store, 1)
	tracker.SetActive(alice, false)
	tracker.SetActive(alice, false)
	tracker.SetActive(alice, true)
	time.Sleep(100 * time.Millisecond)
	if got := writeCount(store); got != 1 {
		t.Fatalf("writes during grace = %d, want 1", got)
	}
	tracker.SetActive(alice, false)
	waitWrites(t, store, 2)
	store.mu.Lock()
	if store.writes[1][alice] {
		t.Fatal("expected offline write")
	}
	store.writeErr = errors.New("redis down")
	store.mu.Unlock()
	tracker.SetActive(alice, true)
	waitWrites(t, store, 3)
	store.mu.Lock()
	store.writeErr = nil
	store.mu.Unlock()
	waitWrites(t, store, 4)
}

type recorderFunc func(context.Context, []grpcauth.LastSeen) error

func (f recorderFunc) RecordLastSeen(ctx context.Context, entries []grpcauth.LastSeen) error {
	return f(ctx, entries)
}

func writeCount(store *fakeStore) int {
	store.mu.Lock()
	defer store.mu.Unlock()
	return len(store.writes)
}

func waitWrites(t *testing.T, store *fakeStore, want int) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for writeCount(store) < want {
		if time.Now().After(deadline) {
			t.Fatalf("writes = %d, want %d", writeCount(store), want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestCoarseLastSeenBuckets(t *testing.T) {
	now := time.Now()
	for _, tc := range []struct {
		online bool
		age    time.Duration
		want   string
	}{
		{true, 0, "recently"},
		{false, time.Hour, "recently"},
		{false, 4 * 24 * time.Hour, "within_week"},
		{false, 10 * 24 * time.Hour, "within_month"},
		{false, 40 * 24 * time.Hour, "long_ago"},
	} {
		if got := coarse(tc.online, now.Add(-tc.age), now); got != tc.want {
			t.Fatalf("coarse(%v, %s) = %s, want %s", tc.online, tc.age, got, tc.want)
		}
	}
	if got := coarse(false, time.Time{}, now); got != "long_ago" {
		t.Fatalf("never seen = %s", got)
	}
}

func TestHubSuspendsRevokedGrantsUntilRenewal(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	auth.mu.Lock()
	auth.levels = map[string]grpcauth.PresenceLevel{alice: grpcauth.PresenceNone}
	auth.mu.Unlock()
	hub.Revalidate(bob)
	store.publish(alice, true, 1)
	event := bob.next(t)
	if len(event.Statuses) != 0 || len(event.Unavailable) != 1 || event.Unavailable[0] != alice {
		t.Fatalf("after revocation = %+v", event)
	}
	bob.quiet(t)
}

func TestHubResyncAcceptsRolledBackState(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	store.states[alice] = redisroom.PresenceState{Online: true, Version: 10}
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	store.mu.Lock()
	store.states[alice] = redisroom.PresenceState{Online: false, Version: 3, LastSeen: time.Now().UnixMilli()}
	store.mu.Unlock()
	hub.resync(context.Background(), hub.buckets[roomname.PresenceBucketOf(alice)])
	hub.flushWatch(hub.watches[bob])
	if event := bob.next(t); event.Statuses[0].Online {
		t.Fatalf("rolled back state ignored: %+v", event)
	}
}

func TestHubBoundsRejectionsForHiddenSockets(t *testing.T) {
	store := newFakeStore()
	auth := &fakeAuth{levels: map[string]grpcauth.PresenceLevel{}}
	for i := range 5 {
		auth.levels[user(i)] = grpcauth.PresenceNone
	}
	config := testConfig()
	config.MaxWatched = 3
	hub := startHub(t, store, auth, config)
	bob := newFakeWatcher()
	hub.Watch(context.Background(), bob, nil, nil, false)
	hub.SetVisible(bob, false)
	for range 3 {
		hub.Watch(context.Background(), bob, []string{user(0), user(1), user(2), user(3), user(4)}, nil, false)
	}
	hub.mu.Lock()
	size := len(hub.watches[bob].unavailable)
	hub.mu.Unlock()
	if size > 3 {
		t.Fatalf("pending rejections = %d", size)
	}
}

func TestTrackerRemovesGatewayFromItsIndex(t *testing.T) {
	store := newFakeStore()
	tracker := NewTracker(store, recorderFunc(func(context.Context, []grpcauth.LastSeen) error { return nil }), func() string { return "gateway" }, testConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	store.SetPresence(context.Background(), "dead", map[string]bool{user(1): true})
	if err := tracker.RemoveGateway(context.Background(), "dead"); err != nil {
		t.Fatal(err)
	}
	if last := store.writes[len(store.writes)-1]; last[user(1)] {
		t.Fatalf("dead gateway still online: %v", last)
	}
}

func TestTrackerClearsRecentlyOfflineUsersAgainOnRefresh(t *testing.T) {
	store := newFakeStore()
	tracker := NewTracker(store, recorderFunc(func(context.Context, []grpcauth.LastSeen) error { return nil }), func() string { return "gateway" }, testConfig(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	alice := user(1)
	tracker.SetActive(alice, true)
	tracker.write(context.Background())
	tracker.SetActive(alice, false)
	time.Sleep(80 * time.Millisecond)
	tracker.write(context.Background())
	before := writeCount(store)
	tracker.refresh(time.Now())
	tracker.write(context.Background())
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.writes) != before+1 || store.writes[before][alice] {
		t.Fatalf("refresh writes = %v", store.writes[before:])
	}
}
