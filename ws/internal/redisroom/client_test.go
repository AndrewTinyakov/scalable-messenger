package redisroom

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/redis/go-redis/v9"
)

type replayRedis struct {
	redis.UniversalClient
	epochReads   int
	anchorReads  int
	changeEpoch  bool
	trimAnchor   bool
	eventPayload string
}

func (client *replayRedis) Get(context.Context, string) *redis.StringCmd {
	client.epochReads++
	epoch := "epoch"
	if client.changeEpoch && client.epochReads > 1 {
		epoch = "new-epoch"
	}
	return redis.NewStringResult(epoch, nil)
}

func (client *replayRedis) XRangeN(_ context.Context, _, start, end string, _ int64) *redis.XMessageSliceCmd {
	if start == end {
		client.anchorReads++
		if client.trimAnchor && client.anchorReads > 1 {
			return redis.NewXMessageSliceCmdResult(nil, nil)
		}
		return redis.NewXMessageSliceCmdResult([]redis.XMessage{{ID: start}}, nil)
	}
	const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	payload := `{"type":"chat_created","version":1,"eventId":"` + id + `","room":"user:` + id + `","chatId":"` + id + `","userSeq":"1"}`
	if client.eventPayload != "" {
		payload = client.eventPayload
	}
	return redis.NewXMessageSliceCmdResult([]redis.XMessage{{ID: "3-0", Values: map[string]any{"event": payload}}}, nil)
}

func TestRoomKeysShareClusterSlot(t *testing.T) {
	room := "group:01ARZ3NDEKTSV4RRFFQ69G5FAV"
	if got, want := StreamKey(room), "messenger:{"+room+"}:stream"; got != want {
		t.Fatalf("stream key = %q, want %q", got, want)
	}
	if got, want := EpochKey(room), "messenger:{"+room+"}:epoch"; got != want {
		t.Fatalf("epoch key = %q, want %q", got, want)
	}
	if got, want := Channel(room), "messenger:{"+room+"}:live"; got != want {
		t.Fatalf("channel = %q, want %q", got, want)
	}
}

func TestDecodeLivePreservesPreviousStreamID(t *testing.T) {
	const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	room := "user:" + id
	payload := `{"epoch":"epoch","streamId":"3-0","previousStreamId":"2-0","event":{"type":"chat_created","version":1,"eventId":"` + id + `","room":"` + room + `","chatId":"` + id + `","userSeq":"1"}}`
	live, err := decodeLive(room, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !live.HasPrevious || live.PreviousStreamID != "2-0" {
		t.Fatalf("previous Stream ID = %q (present=%v), want 2-0", live.PreviousStreamID, live.HasPrevious)
	}
}

func TestMembershipChangedLiveAndReplayRejectForbiddenEmptyFields(t *testing.T) {
	fixture, err := os.ReadFile("../../../contracts/fixtures/valid/membership-changed.json")
	if err != nil {
		t.Fatal(err)
	}
	const room = "group:01ARZ3NDEKTSV4RRFFQ69G5FAV"
	check := func(t *testing.T, payload []byte, valid bool) {
		t.Helper()
		envelope, err := json.Marshal(map[string]any{"epoch": "epoch", "streamId": "3-0", "previousStreamId": "2-0", "event": json.RawMessage(payload)})
		if err != nil {
			t.Fatal(err)
		}
		live, liveErr := decodeLive(room, string(envelope))
		client := &Client{redis: &replayRedis{eventPayload: string(payload)}}
		replayed, replayErr := client.Replay(context.Background(), room, "epoch", "1-0", 8)
		if !valid {
			if liveErr == nil || replayErr == nil {
				t.Fatalf("malformed membership accepted: live=%v replay=%v", liveErr, replayErr)
			}
			return
		}
		if liveErr != nil || replayErr != nil || len(replayed) != 1 {
			t.Fatalf("valid membership rejected: live=%v replay=%v events=%d", liveErr, replayErr, len(replayed))
		}
		if !reflect.DeepEqual(live.Event, replayed[0].Event) || !live.HasPrevious || live.PreviousStreamID != "2-0" {
			t.Fatalf("live/replay metadata differs: live=%+v replay=%+v", live, replayed)
		}
	}
	check(t, fixture, true)
	for _, field := range []string{"sequence", "requestId", "memberId", "sessionId", "body", "createdAt", "recipientId", "messageId", "reason", "code", "epoch", "streamId"} {
		t.Run(field, func(t *testing.T) {
			var event map[string]any
			if err := json.Unmarshal(fixture, &event); err != nil {
				t.Fatal(err)
			}
			event[field] = ""
			payload, err := json.Marshal(event)
			if err != nil {
				t.Fatal(err)
			}
			check(t, payload, false)
		})
	}
}

func TestReplayRequiresRetainedAnchorAndEpochAfterReading(t *testing.T) {
	for _, name := range []string{"complete", "changed epoch", "trimmed anchor"} {
		t.Run(name, func(t *testing.T) {
			store := &replayRedis{changeEpoch: name == "changed epoch", trimAnchor: name == "trimmed anchor"}
			client := &Client{redis: store}
			items, err := client.Replay(context.Background(), "user:01ARZ3NDEKTSV4RRFFQ69G5FAV", "epoch", "1-0", 8)
			if name == "complete" {
				if err != nil || len(items) != 1 || items[0].StreamID != "3-0" {
					t.Fatalf("complete replay = %+v, %v", items, err)
				}
			} else if !errors.Is(err, ErrGap) || len(items) != 0 {
				t.Fatalf("replay after history changed = %+v, %v; want gap", items, err)
			}
		})
	}
}

func TestDecodeLiveRejectsAmbiguousEnvelope(t *testing.T) {
	const id = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
	room := "user:" + id
	payload := `{"epoch":"epoch","streamId":"3-0","event":{"type":"chat_created","version":1,"eventId":"` + id + `","room":"` + room + `","chatId":"` + id + `","userSeq":"1"}}`
	for _, invalid := range []string{
		strings.Replace(payload, `"epoch":"epoch"`, `"epoch":"epoch","epoch":"changed"`, 1),
		strings.Replace(payload, `"epoch":"epoch"`, `"Epoch":"epoch"`, 1),
		strings.Replace(payload, `"epoch":"epoch"`, `"epoch":"epoch","previousStreamId":null`, 1),
	} {
		if _, err := decodeLive(room, invalid); err == nil {
			t.Fatalf("accepted ambiguous live envelope: %s", invalid)
		}
	}
}
