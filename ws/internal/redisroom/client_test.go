package redisroom

import "testing"

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
	payload := `{"epoch":"epoch","streamId":"3-0","previousStreamId":"2-0","event":{"type":"chat_created","version":1,"eventId":"` + id + `","room":"` + room + `","chatId":"` + id + `"}}`
	live, err := decodeLive(room, payload)
	if err != nil {
		t.Fatal(err)
	}
	if !live.HasPrevious || live.PreviousStreamID != "2-0" {
		t.Fatalf("previous Stream ID = %q (present=%v), want 2-0", live.PreviousStreamID, live.HasPrevious)
	}
}
