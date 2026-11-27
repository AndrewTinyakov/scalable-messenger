package presence

import (
	"context"
	"encoding/json"
	"slices"
	"testing"
	"time"

	"messenger/ws/internal/grpcauth"
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
		s.send(b, string(payload))
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
	bob := newFakeWatcher()
	// Bob's first watch of Alice reads that he may see her, then stalls while
	// she is removed. No other socket here watches her.
	release := make(chan struct{})
	auth.mu.Lock()
	auth.hold = release
	auth.mu.Unlock()
	watched := make(chan error, 1)
	go func() { watched <- hub.Watch(context.Background(), bob, []string{alice}, nil, false) }()
	waitHeld(auth, func() bool { return auth.hold != nil })
	deny(auth, alice)
	store.revoke(alice)
	time.Sleep(20 * time.Millisecond)
	close(release)
	if err := <-watched; err != nil {
		t.Fatal(err)
	}
	// The suspended result is checked again at once, not at the next sweep.
	if event := bob.next(t); len(event.Statuses) != 0 || !slices.Equal(event.Unavailable, []string{alice}) {
		t.Fatalf("after the stale add = %+v", event)
	}
	store.publish(alice, true, 1)
	bob.quiet(t)
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

func TestHubFencesARosterReadBeforeARevocation(t *testing.T) {
	store := newFakeStore()
	alice, carol := user(1), user(3)
	auth := &fakeAuth{members: map[string][]string{"group": {alice, carol}}}
	hub := startHub(t, store, auth, testConfig())
	// Another socket watches Alice, so her bucket is subscribed here.
	dave := newFakeWatcher()
	if err := hub.Watch(context.Background(), dave, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	dave.next(t)
	bob := newFakeWatcher()
	release := make(chan struct{})
	auth.mu.Lock()
	auth.countHold = release
	auth.mu.Unlock()
	go func() { _ = hub.WatchOnlineCount(context.Background(), bob, "group") }()
	waitHeld(auth, func() bool { return auth.countHold != nil })
	auth.mu.Lock()
	auth.members["group"] = []string{carol}
	auth.mu.Unlock()
	store.revoke(alice)
	time.Sleep(20 * time.Millisecond)
	close(release)
	if event := bob.next(t); event.Members != 1 {
		t.Fatalf("count from a roster read before the revocation = %+v", event)
	}
	bob.quiet(t)
}

func TestHubRenewalDoesNotRestoreARemovedWatch(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	release := make(chan struct{})
	auth.mu.Lock()
	auth.hold = release
	auth.mu.Unlock()
	hub.Revalidate(bob)
	waitHeld(auth, func() bool { return auth.hold != nil })
	if err := hub.Watch(context.Background(), bob, nil, []string{alice}, false); err != nil {
		t.Fatal(err)
	}
	close(release)
	time.Sleep(50 * time.Millisecond)
	hub.mu.Lock()
	restored := hub.watches[bob].grants[alice] != nil
	hub.mu.Unlock()
	if restored {
		t.Fatal("a renewal restored a removed watch")
	}
	store.publish(alice, true, 1)
	bob.quiet(t)
}

func TestHubIgnoresMalformedRevocations(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	bucket := roomname.PresenceBucketOf(alice)
	foreign := user(2)
	for roomname.PresenceBucketOf(foreign) == bucket {
		foreign += "x"
	}
	hub.mu.Lock()
	generation := hub.watches[bob].authorized
	hub.mu.Unlock()
	for _, raw := range []string{`{"r":[]}`, `{"r":["` + foreign + `"]}`, `{"u":"` + alice + `","r":["` + alice + `"]}`} {
		store.send(bucket, raw)
	}
	time.Sleep(20 * time.Millisecond)
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.watches[bob].authorized != generation || !hub.watches[bob].grants[alice].expires.After(time.Now()) {
		t.Fatal("a malformed revocation changed the watch")
	}
}

func TestHubKeepsANewerAddFencedAfterAnOldRenewalEnds(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	// A renewal of Alice stalls; Bob removes and adds her again meanwhile.
	renewal := make(chan struct{})
	auth.mu.Lock()
	auth.hold = renewal
	auth.mu.Unlock()
	hub.Revalidate(bob)
	waitHeld(auth, func() bool { return auth.hold != nil })
	if err := hub.Watch(context.Background(), bob, nil, []string{alice}, false); err != nil {
		t.Fatal(err)
	}
	add := make(chan struct{})
	auth.mu.Lock()
	auth.hold = add
	auth.mu.Unlock()
	watched := make(chan error, 1)
	go func() { watched <- hub.Watch(context.Background(), bob, []string{alice}, nil, false) }()
	waitHeld(auth, func() bool { return auth.hold != nil })
	// The old renewal ends while the new add is still in flight.
	close(renewal)
	time.Sleep(20 * time.Millisecond)
	deny(auth, alice)
	store.revoke(alice)
	time.Sleep(20 * time.Millisecond)
	close(add)
	if err := <-watched; err != nil {
		t.Fatal(err)
	}
	for {
		event := bob.next(t)
		if len(event.Statuses) != 0 {
			t.Fatalf("a revoked user's status was sent: %+v", event)
		}
		if slices.Contains(event.Unavailable, alice) {
			break
		}
	}
	store.publish(alice, true, 1)
	bob.quiet(t)
}

func TestHubRejectsARevocationMixedWithATransition(t *testing.T) {
	store, auth := newFakeStore(), &fakeAuth{}
	alice := user(1)
	hub := startHub(t, store, auth, testConfig())
	bob := newFakeWatcher()
	if err := hub.Watch(context.Background(), bob, []string{alice}, nil, false); err != nil {
		t.Fatal(err)
	}
	bob.next(t)
	hub.mu.Lock()
	generation := hub.watches[bob].authorized
	hub.mu.Unlock()
	for _, raw := range []string{`{"r":["` + alice + `"],"v":"9","s":1,"o":true}`, `{"r":["` + alice + `"],"o":false}`, `{"r":["` + alice + `"],"s":0}`, `{"R":["` + alice + `"]}`} {
		store.send(roomname.PresenceBucketOf(alice), raw)
	}
	time.Sleep(20 * time.Millisecond)
	hub.mu.Lock()
	defer hub.mu.Unlock()
	if hub.watches[bob].authorized != generation {
		t.Fatal("a mixed message was taken as a revocation")
	}
}
