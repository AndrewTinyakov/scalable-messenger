package roomname

import "testing"

func TestPresenceBucketLayoutIsStable(t *testing.T) {
	for userID, want := range map[string]int{
		"01ARZ3NDEKTSV4RRFFQ69G5FAV": 3456,
		"01HZY8Z5V9Q4N6R2K7M3T1W0XB": 2292,
		"7ZZZZZZZZZZZZZZZZZZZZZZZZZ": 276,
	} {
		if got := PresenceBucketOf(userID); got != want {
			t.Fatalf("bucket(%q) = %d, want %d", userID, got, want)
		}
	}
	if got := PresenceBucket(17); got != "presence:17" || !IsPresence(got) {
		t.Fatalf("room = %q", got)
	}
}
