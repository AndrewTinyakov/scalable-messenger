package socket

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"messenger/ws/internal/config"
	"messenger/ws/internal/presence"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/ticket"
)

type recordingPresence struct {
	serverTestDependencies
	mu      sync.Mutex
	active  []bool
	visible []bool
	removed int
	watched [][]string
}

func (r *recordingPresence) SetActive(_ string, active bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.active = append(r.active, active)
}
func (r *recordingPresence) SetVisible(_ presence.Watcher, visible bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.visible = append(r.visible, visible)
}
func (r *recordingPresence) Remove(presence.Watcher) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.removed++
}
func (r *recordingPresence) Watch(_ context.Context, _ presence.Watcher, add, _ []string, _ bool) error {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.watched = append(r.watched, add)
	return nil
}

func TestConnectionReportsActivityTransitionsOnce(t *testing.T) {
	cfg := config.Config{MaxGroupAuths: 8, QueueItems: 32, QueueBytes: 65536, APITimeout: time.Second, WriteTimeout: time.Second, PingInterval: time.Hour, IdleAfterHidden: 5 * time.Second, IdleAfterInput: 30 * time.Second, ReleaseAfterHidden: 5 * time.Minute}
	recorder := &recordingPresence{}
	dependencies := testDependencies(&sessionRooms{})
	dependencies.Presence, dependencies.Watchers = recorder, recorder
	s := newTestServer(t, cfg, dependencies)
	c := newConnection(s, nil, ticket.Identity{UserID: sessionTestUser, SessionID: strings.Repeat("a", 64)})
	c.setActivity(false, false)
	c.startPresence()
	if event := (<-c.out).frame.Event(); event.Type != protocol.EventPresenceConfig || event.IdleAfterHiddenMS != 5000 || event.IdleAfterInputMS != 30000 || event.ReleaseAfterHiddenMS != 300000 {
		t.Fatalf("config = %+v", event)
	}
	c.setActivity(true, true)
	c.setActivity(false, false)
	c.setActivity(false, true)
	if err := c.handle(protocol.Frame{Type: protocol.FrameWatchPresence, Version: 1, Add: []string{sessionTestUser}}); err != nil {
		t.Fatal(err)
	}
	c.Close()
	c.setActivity(true, true)
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if got := recorder.active; len(got) != 2 || !got[0] || got[1] {
		t.Fatalf("active transitions = %v, want one activation and one idle", got)
	}
	if len(recorder.visible) != 3 || recorder.removed != 1 || len(recorder.watched) != 1 {
		t.Fatalf("visible=%v removed=%d watched=%v", recorder.visible, recorder.removed, recorder.watched)
	}
}
