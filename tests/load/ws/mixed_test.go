package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func mixedFixture() mixedScenario {
	return mixedScenario{Seed: 1103, ActiveSenderFraction: 0.2, Payloads: []mixedPayload{{Bytes: 256, Weight: 8}, {Bytes: 1000, Weight: 2}}, Groups: []mixedCohort{{Count: 6, Members: 3, MessagesPerSecond: 2}, {Count: 2, Members: 10, MessagesPerSecond: 5}}}
}

func mixedSessions(count int) []session {
	sessions := make([]session, count)
	for index := range sessions {
		sessions[index] = session{UserID: fmt.Sprintf("user-%d", index), Cookie: "messenger_session=test"}
	}
	return sessions
}

func TestMixedSeedRepeatsMembershipTimingSenderAndPayloadChoices(t *testing.T) {
	first, second := &mixedWorkload{scenario: mixedFixture()}, &mixedWorkload{scenario: mixedFixture()}
	for _, mixed := range []*mixedWorkload{first, second} {
		if err := mixed.plan(mixedSessions(20), 40, 30*time.Second, 10000); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(first.schedule, second.schedule) {
		t.Fatal("same seed changed offered schedule")
	}
	if first.selectedActiveUsers != 4 || first.activeUsers > 4 || first.offeredRate != 22 || first.offeredNotifications != 272 {
		t.Fatalf("unexpected offered load: %+v", first)
	}
	for index, chat := range first.chats {
		other := second.chats[index]
		if !reflect.DeepEqual(chat.members, other.members) || !reflect.DeepEqual(chat.senders, other.senders) {
			t.Fatal("same seed changed membership or active senders")
		}
		members := make(map[int]bool)
		for _, member := range chat.members {
			if members[member] {
				t.Fatal("group contains a duplicate member")
			}
			members[member] = true
		}
		for _, sender := range chat.senders {
			if !members[sender] {
				t.Fatal("sender is not a chat member")
			}
		}
	}
	for index, send := range first.schedule {
		if send.at < 0 || send.at >= 30*time.Second || index > 0 && send.at < first.schedule[index-1].at {
			t.Fatal("schedule is not ordered within measurement duration")
		}
		found := false
		for _, sender := range first.chats[send.chat].senders {
			found = found || sender == send.sender
		}
		if !found || send.bytes != 256 && send.bytes != 1000 {
			t.Fatal("scheduled invalid sender or payload")
		}
	}
	changed := mixedFixture()
	changed.Seed++
	third := &mixedWorkload{scenario: changed}
	if err := third.plan(mixedSessions(20), 40, 30*time.Second, 10000); err != nil {
		t.Fatal(err)
	}
	if reflect.DeepEqual(first.schedule, third.schedule) {
		t.Fatal("different seed repeated offered schedule")
	}
}

func TestMixedBoundsRejectUnrepresentableOrTruncatedWorkloads(t *testing.T) {
	for _, test := range []struct {
		name                      string
		scenario                  mixedScenario
		users, connections, limit int
	}{
		{"more members than users", mixedFixture(), 5, 5, 10000},
		{"message cap", mixedFixture(), 20, 20, 1},
		{"subscription cap", mixedScenario{Seed: 1, ActiveSenderFraction: 1, Payloads: []mixedPayload{{Bytes: 80, Weight: 1}}, Groups: []mixedCohort{{Count: 65, Members: 2, MessagesPerSecond: 1}}}, 2, 2, 10000},
		{"socket subscription cap", mixedScenario{Seed: 1, ActiveSenderFraction: 1, Payloads: []mixedPayload{{Bytes: 80, Weight: 1}}, Groups: []mixedCohort{{Count: 21, Members: 1000, MessagesPerSecond: 1}}}, 1000, 10000, 10000},
	} {
		t.Run(test.name, func(t *testing.T) {
			mixed := &mixedWorkload{scenario: test.scenario}
			if err := mixed.plan(mixedSessions(test.users), test.connections, time.Minute, test.limit); err == nil {
				t.Fatal("accepted workload beyond declared bounds")
			}
		})
	}
	invalid := mixedFixture()
	invalid.Groups = []mixedCohort{{Count: 2001, Members: 2, MessagesPerSecond: 1}}
	if invalid.validate() == nil {
		t.Fatal("accepted unbounded group count")
	}
}

func TestMixedScenarioDecoderRejectsUnknownFieldsAndTrailingDocuments(t *testing.T) {
	path := filepath.Join(t.TempDir(), "scenario.json")
	valid, err := json.Marshal(mixedFixture())
	if err != nil {
		t.Fatal(err)
	}
	for _, payload := range []string{`{"seed":1,"unknown":true}`, string(valid) + ` {}`, strings.Repeat(" ", 1<<20) + string(valid)} {
		if err := os.WriteFile(path, []byte(payload), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := readMixedScenario(path); err == nil {
			t.Fatal("accepted invalid scenario manifest")
		}
	}
}

func TestMixedInterleavedChatsKeepSequencesAndAcknowledgementsSeparate(t *testing.T) {
	acknowledged := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		conn, err := (&websocket.Upgrader{}).Upgrade(writer, request, nil)
		if err != nil {
			acknowledged <- err
			return
		}
		defer conn.Close()
		conn.SetReadDeadline(time.Now().Add(5 * time.Second))
		expected := []event{{Type: "applied", ChatID: "a", Sequence: "11"}, {Type: "applied", ChatID: "b", Sequence: "21"}, {Type: "received_message", ChatID: "a", Sequence: "11"}}
		for _, want := range expected {
			var got event
			if err := conn.ReadJSON(&got); err != nil {
				acknowledged <- err
				return
			}
			if got.Type != want.Type || got.ChatID != want.ChatID || got.Sequence != want.Sequence {
				acknowledged <- fmt.Errorf("ack %+v, want %+v", got, want)
				return
			}
		}
		acknowledged <- nil
	}))
	defer server.Close()
	conn, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	a, b := &mixedChat{id: "a", baseline: 10}, &mixedChat{id: "b", baseline: 20}
	work := &run{prefix: "capacity_test|", mixed: &mixedWorkload{chats: []*mixedChat{a, b}}}
	socket := &client{owner: work, conn: conn, chats: map[string]*chatProgress{"a": {chat: a, sequence: 10}, "b": {chat: b, sequence: 20}}}
	for _, frame := range []event{{ChatID: "a", Sequence: "11"}, {ChatID: "b", Sequence: "21"}, {ChatID: "a", Sequence: "11"}} {
		frame.Body = "capacity_test|0|"
		if err := socket.saved(frame); err != nil {
			t.Fatal(err)
		}
	}
	if socket.chats["a"].sequence != 11 || socket.chats["b"].sequence != 21 || socket.delivered.Load() != 2 || socket.duplicates.Load() != 1 {
		t.Fatal("interleaved chats corrupted independent progress")
	}
	if socket.saved(event{ChatID: "b", Sequence: "23", Body: "capacity_test|0|"}) == nil {
		t.Fatal("accepted a gap in chat b")
	}
	if socket.saved(event{ChatID: "unassigned", Sequence: "1"}) == nil {
		t.Fatal("accepted a notification outside membership")
	}
	select {
	case err := <-acknowledged:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("acknowledgements did not finish")
	}
}

func TestMixedExpectedNotificationsFollowEachSocketMembership(t *testing.T) {
	a, b := &mixedChat{id: "a"}, &mixedChat{id: "b"}
	a.sent.Store(2)
	b.sent.Store(1)
	work := &run{mixed: &mixedWorkload{chats: []*mixedChat{a, b}}}
	first := &client{owner: work, chats: map[string]*chatProgress{"a": {chat: a}}}
	second := &client{owner: work, chats: map[string]*chatProgress{"a": {chat: a}, "b": {chat: b}}}
	first.chats["a"].delivered.Store(2)
	first.delivered.Store(2)
	second.chats["a"].delivered.Store(1)
	second.chats["b"].delivered.Store(1)
	second.delivered.Store(2)
	first.connected.Store(true)
	second.connected.Store(true)
	work.clients = []*client{first, second}
	work.sent.Store(3)
	work.queued.Store(3)
	report := work.report()
	if report["missingHealthyNotifications"] != int64(1) || report["receivedNotifications"] != int64(4) || report["scenario"].(map[string]any)["expectedNotifications"] != int64(5) || work.complete() {
		t.Fatalf("membership denominator was lost: %v", report)
	}
	second.chats["a"].delivered.Store(2)
	if !work.complete() {
		t.Fatal("complete membership-specific progress did not finish")
	}
}

func TestMixedReadinessWaitsForEveryAssignedChat(t *testing.T) {
	socket := &client{ready: make(chan struct{}), chats: map[string]*chatProgress{"a": {}, "b": {}}}
	if err := socket.subscribedMixed("a"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-socket.ready:
		t.Fatal("ready before chat b subscribed")
	default:
	}
	if err := socket.subscribedMixed("outside"); err == nil {
		t.Fatal("accepted unassigned subscription")
	}
	if err := socket.subscribedMixed("b"); err != nil {
		t.Fatal(err)
	}
	select {
	case <-socket.ready:
	default:
		t.Fatal("not ready after both subscriptions")
	}
}

func TestMixedExpiredMeasurementReportsCancelledSchedule(t *testing.T) {
	work := &run{opts: options{maxMessages: 1}, mixed: &mixedWorkload{users: mixedSessions(1), schedule: []mixedSend{{at: time.Millisecond}}}}
	work.clients = []*client{{owner: work, session: work.mixed.users[0]}}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := work.measureMixed(ctx); err != nil {
		t.Fatal(err)
	}
	if work.mixed.cancelled.Load() != 1 || work.mixed.dispatched.Load() != 0 || work.sent.Load() != 0 || work.errors.Load() != 1 {
		t.Fatal("cancelled offered traffic was silently omitted")
	}
}
