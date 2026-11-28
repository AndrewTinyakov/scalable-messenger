package roomname

import (
	"encoding/json"
	"os"
	"testing"
)

func TestPresenceBucketsMatchKotlinPublisherVectors(t *testing.T) {
	data, err := os.ReadFile("testdata/presence-buckets.json")
	if err != nil {
		t.Fatal(err)
	}
	var buckets map[string]int
	if err := json.Unmarshal(data, &buckets); err != nil {
		t.Fatal(err)
	}
	if len(buckets) == 0 {
		t.Fatal("presence bucket fixture is empty")
	}
	for userID, want := range buckets {
		if got := PresenceBucketOf(userID); got != want {
			t.Fatalf("bucket(%q) = %d, want %d", userID, got, want)
		}
	}
}

func TestPresenceBucketRoomName(t *testing.T) {
	if got := PresenceBucket(17); got != "presence:17" || !IsPresence(got) {
		t.Fatalf("room = %q", got)
	}
}
