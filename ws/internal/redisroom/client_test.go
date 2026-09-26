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
