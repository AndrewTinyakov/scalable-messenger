package presence

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/redisroom"
	"messenger/ws/internal/roomname"
)

// revoke sends a revocation on each user's bucket, the way the outbox
// publisher does after a removal or a group deletion.
func (s *fakeStore) revoke(userIDs ...string) {
	byBucket := make(map[int][]string)
	for _, id := range userIDs {
		b := roomname.PresenceBucketOf(id)
		byBucket[b] = append(byBucket[b], id)
	}
	for b, ids := range byBucket {
		payload, _ := json.Marshal(revocation{Revoked: ids})
		s.mu.Lock()
		feeds := append([]chan redisroom.Live(nil), s.feeds[b]...)
		s.mu.Unlock()
		for _, feed := range feeds {
			feed <- redisroom.Live{Raw: string(payload)}
		}
	}
}

func deny(auth *fakeAuth, ids ...string) {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	auth.levels = make(map[string]grpcauth.PresenceLevel)
	for _, id := range ids {
		auth.levels[id] = grpcauth.PresenceNone
	}
}

func lastCall(auth *fakeAuth) []string {
	auth.mu.Lock()
	defer auth.mu.Unlock()
	call := slices.Clone(auth.calls[len(auth.calls)-1])
	slices.Sort(call)
	return call
}

func TestHubRechecksOnlyTheRevokedSubject(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice, carol := user(1), user(3)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice, carol}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	// Alice was removed from the only chat she shared with Bob.
	deny(auth, alice)
	store.revoke(alice)
	event := bob.next(t)
	if len(event.Statuses) != 0 || !slices.Equal(event.Unavailable, []string{alice}) {
		t.Fatalf("after revocation = %+v", event)
	}
	if call := lastCall(auth); !slices.Equal(call, []string{alice}) {
		t.Fatalf("rechecked %v, want only alice", call)
	}
	store.publish(alice, true, 1)
	bob.quiet(t)
	store.publish(carol, true, 1)
	if event := bob.next(t); len(event.Statuses) != 1 || event.Statuses[0].UserID != carol {
		t.Fatalf("carol after revocation = %+v", event)
	}
}

func TestHubKeepsASubjectAnotherChatStillShares(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	store.revoke(alice)
	// The recheck keeps access and sends the current status again.
	if event := bob.next(t); len(event.Unavailable) != 0 || len(event.Statuses) != 1 {
		t.Fatalf("after the recheck = %+v", event)
	}
	store.publish(alice, true, 1)
	if event := bob.next(t); len(event.Unavailable) != 0 || len(event.Statuses) != 1 || !event.Statuses[0].Online {
		t.Fatalf("after a revocation that changed nothing = %+v", event)
	}
}

func TestHubRevocationLeavesTheBucketSequenceAlone(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	store.publish(alice, true, 1)
	bob.next(t)
	store.revoke(alice)
	bob.next(t)
	store.mu.Lock()
	subscribes, snapshots := store.subscribes, store.snapshots
	store.mu.Unlock()
	store.publish(alice, false, 1)
	if event := bob.next(t); len(event.Statuses) != 1 || event.Statuses[0].Online {
		t.Fatalf("after revocation = %+v", event)
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if store.subscribes != subscribes || store.snapshots != snapshots {
		t.Fatal("a revocation was read as a sequence gap")
	}
}

func TestHubSuspendsAnAddAuthorizedBeforeARevocation(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	// Another socket on this gateway already watches Alice, so her bucket is subscribed.
	dave := newFakeWatcher()
	if err := hub.Watch(context.Background(), dave, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	dave.next(t)
	bob := newFakeWatcher()
	// Bob's add reads that he may see Alice, then stalls while she is removed.
	release := make(chan struct{})
	auth.mu.Lock()
	auth.hold = release
	auth.mu.Unlock()
	watched := make(chan error, 1)
	go func() { watched <- hub.Watch(context.Background(), bob, []string{alice}, nil, false) }()
	for held := true; held; time.Sleep(time.Millisecond) {
		auth.mu.Lock()
		held = auth.hold != nil
		auth.mu.Unlock()
	}
	deny(auth, alice)
	store.revoke(alice)
	time.Sleep(20 * time.Millisecond)
	close(release)
	if err := <-watched; err != nil {
		t.Fatal(err)
	}
	store.publish(alice, true, 1)
	bob.quiet(t)
	hub.sweep(time.Now())
	if event := bob.next(t); len(event.Statuses) != 0 || !slices.Equal(event.Unavailable, []string{alice}) {
		t.Fatalf("after the stale add = %+v", event)
	}
}

func TestHubRefreshesCountsThatIncludeARevokedMember(t *testing.T) {
	store := newFakeStore()
	alice, carol := user(1), user(3)
	auth := &fakeAuth{members: map[string][]string{"group": {alice, carol}}}
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.WatchOnlineCount(context.Background(), bob, "group"); err != nil {
		t.Fatal(err)
	}
	if event := bob.next(t); event.Members != 2 {
		t.Fatalf("count = %+v", event)
	}
	auth.mu.Lock()
	auth.members["group"] = []string{carol}
	auth.mu.Unlock()
	store.revoke(alice)
	if event := bob.next(t); event.Members != 1 {
		t.Fatalf("count after revocation = %+v", event)
	}
}
