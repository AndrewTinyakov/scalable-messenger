package fleet

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"sync"
	"testing"
	"time"
)

type fakeStore struct {
	mu        sync.Mutex
	counts    map[string]map[string]int
	users     map[string]map[string]bool
	gateways  map[string]time.Time
	dead      map[string]bool
	claimed   map[string]bool
	admitErr  error
	writeErrs int
}

func newFakeStore() *fakeStore {
	return &fakeStore{counts: make(map[string]map[string]int), users: make(map[string]map[string]bool), gateways: make(map[string]time.Time), dead: make(map[string]bool), claimed: make(map[string]bool)}
}

func (s *fakeStore) total(userID string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	total := 0
	for _, count := range s.counts[userID] {
		total += count
	}
	return total
}

func (s *fakeStore) AdmitConnection(_ context.Context, userID, gateway string, limit int) (bool, error) {
	if s.admitErr != nil {
		return false, s.admitErr
	}
	if s.total(userID) >= limit {
		return false, nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.counts[userID] == nil {
		s.counts[userID] = make(map[string]int)
	}
	s.counts[userID][gateway]++
	if s.users[gateway] == nil {
		s.users[gateway] = make(map[string]bool)
	}
	s.users[gateway][userID] = true
	return true, nil
}

func (s *fakeStore) ReleaseConnections(_ context.Context, userID, gateway string, closed int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.writeErrs > 0 {
		s.writeErrs--
		return errors.New("redis down")
	}
	if s.counts[userID][gateway] -= closed; s.counts[userID][gateway] <= 0 {
		delete(s.counts[userID], gateway)
		s.users[gateway][userID] = false
	}
	return nil
}

func (s *fakeStore) UnindexConnections(_ context.Context, userID, gateway string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.users[gateway][userID] = false
	return nil
}

func (s *fakeStore) SetConnections(_ context.Context, userID, gateway string, count int) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.writeErrs > 0 {
		s.writeErrs--
		return errors.New("redis down")
	}
	if s.counts[userID] == nil {
		s.counts[userID] = make(map[string]int)
	}
	if s.users[gateway] == nil {
		s.users[gateway] = make(map[string]bool)
	}
	s.counts[userID][gateway] = count
	s.users[gateway][userID] = count > 0
	return nil
}

func (s *fakeStore) Heartbeat(_ context.Context, gateway string, ttl time.Duration) (bool, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.dead[gateway] {
		return false, true, nil
	}
	_, registered := s.gateways[gateway]
	s.gateways[gateway] = time.Now().Add(ttl)
	return registered, false, nil
}

func (s *fakeStore) ExpiredGateways(context.Context, int64) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var expired []string
	for gateway, deadline := range s.gateways {
		if time.Now().After(deadline) {
			expired = append(expired, gateway)
		}
	}
	return expired, nil
}

func (s *fakeStore) ClaimGateway(_ context.Context, gateway string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.claimed[gateway] {
		return false, nil
	}
	s.claimed[gateway] = true
	return true, nil
}

func (s *fakeStore) GatewayUsers(_ context.Context, gateway string, _ uint64) ([]string, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var users []string
	for userID, present := range s.users[gateway] {
		if present {
			users = append(users, userID)
		}
	}
	return users, 0, nil
}

func (s *fakeStore) RemoveGatewayConnections(_ context.Context, gateway string, users []string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, userID := range users {
		delete(s.counts[userID], gateway)
	}
	return nil
}

func (s *fakeStore) ForgetGateway(_ context.Context, gateway string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.dead[gateway] = true
	delete(s.gateways, gateway)
	delete(s.users, gateway)
	return nil
}

type fakeState struct {
	removed chan string
	renewed chan struct{}
}

func newFakeState() *fakeState {
	return &fakeState{removed: make(chan string, 4), renewed: make(chan struct{}, 4)}
}

func (s *fakeState) RemoveGateway(_ context.Context, gateway string) error {
	select {
	case s.removed <- gateway:
	default:
	}
	return nil
}

func (s *fakeState) Renew() {
	select {
	case s.renewed <- struct{}{}:
	default:
	}
}

func testFleet(store *fakeStore) *Fleet { return testFleetWith(store, newFakeState()) }

func testFleetWith(store *fakeStore, state GatewayState) *Fleet {
	return New(store, state, Config{ConnectionLimit: 2, Heartbeat: 20 * time.Millisecond, TTL: 60 * time.Millisecond, Timeout: time.Second}, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func eventually(t *testing.T, condition func() bool) {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for !condition() {
		if time.Now().After(deadline) {
			t.Fatal("condition not reached")
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestFleetAdmitsWithinLimitAndWritesReleases(t *testing.T) {
	store := newFakeStore()
	f := testFleet(store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go f.Run(ctx)
	for i, want := range []bool{true, true, false} {
		if admitted, err := f.Admit(ctx, "alice"); err != nil || admitted != want {
			t.Fatalf("admit %d = %v, %v; want %v", i, admitted, err, want)
		}
	}
	store.mu.Lock()
	store.writeErrs = 1
	store.mu.Unlock()
	f.Release("alice")
	eventually(t, func() bool { return store.total("alice") == 1 })
	if admitted, err := f.Admit(ctx, "alice"); err != nil || !admitted {
		t.Fatalf("readmit = %v, %v", admitted, err)
	}
	f.Release("alice")
	eventually(t, func() bool { return store.total("alice") == 1 })
	store.admitErr = errors.New("redis down")
	if _, err := f.Admit(ctx, "alice"); err == nil {
		t.Fatal("admission error was hidden")
	}
	eventually(t, func() bool { return store.total("alice") == 1 })
}

func TestFleetRemovesDeadGatewaysAndRenewsItsOwnIdentity(t *testing.T) {
	store := newFakeStore()
	survivorState, crashedState := newFakeState(), newFakeState()
	survivor, crashed := testFleetWith(store, survivorState), testFleetWith(store, crashedState)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := crashed.Admit(ctx, "bob"); err != nil {
		t.Fatal(err)
	}
	crashedCtx, crash := context.WithCancel(ctx)
	go crashed.Run(crashedCtx)
	eventually(t, func() bool {
		store.mu.Lock()
		defer store.mu.Unlock()
		_, ok := store.gateways[crashed.ID()]
		return ok
	})
	crash()
	go survivor.Run(ctx)
	select {
	case gateway := <-survivorState.removed:
		if gateway != crashed.ID() {
			t.Fatalf("cleaned = %s, want %s", gateway, crashed.ID())
		}
	case <-time.After(2 * time.Second):
		t.Fatal("dead gateway was not removed")
	}
	eventually(t, func() bool { return store.total("bob") == 0 })
	old := crashed.ID()
	crashed.heartbeat(ctx)
	if crashed.ID() == old {
		t.Fatal("removed gateway kept its identity")
	}
	select {
	case <-crashedState.renewed:
	case <-time.After(time.Second):
		t.Fatal("state was not rewritten under the new identity")
	}
}

func TestFleetAdmissionGivesUpWaitingWhenItsContextEnds(t *testing.T) {
	f := testFleet(newFakeStore())
	unlock, err := f.lockUser(context.Background(), "alice")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, err := f.Admit(ctx, "alice"); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatalf("admit while locked = %v", err)
	}
	unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.locks) != 0 || f.counts["alice"] != 0 {
		t.Fatalf("locks=%d counts=%v", len(f.locks), f.counts)
	}
}

func TestFleetBlocksAdmissionUntilRenewedCountsAreRestored(t *testing.T) {
	store := newFakeStore()
	f := testFleet(store)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	if _, err := f.Admit(ctx, "alice"); err != nil {
		t.Fatal(err)
	}
	old := f.ID()
	store.mu.Lock()
	store.dead[old] = true
	delete(store.counts, "alice")
	store.mu.Unlock()
	f.heartbeat(ctx)
	if f.ID() == old {
		t.Fatal("identity was not renewed")
	}
	if _, err := f.Admit(ctx, "alice"); !errors.Is(err, ErrRenewing) {
		t.Fatalf("admit during restore = %v", err)
	}
	go f.Run(ctx)
	eventually(t, func() bool { return store.total("alice") == 1 })
	eventually(t, func() bool { admitted, err := f.Admit(ctx, "alice"); return err == nil && admitted })
}
