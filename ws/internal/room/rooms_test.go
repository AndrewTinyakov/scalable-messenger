package room

import "testing"

func TestStreamAfterUsesNumericRedisOrder(t *testing.T) {
	cases := []struct {
		candidate, previous string
		want                bool
	}{
		{"10-0", "9-100", true},
		{"10-2", "10-1", true},
		{"10-1", "10-2", false},
		{"10-1", "10-1", false},
		{"10-1", "", true},
	}
	for _, tc := range cases {
		if got := streamAfter(tc.candidate, tc.previous); got != tc.want {
			t.Errorf("streamAfter(%q,%q) = %v, want %v", tc.candidate, tc.previous, got, tc.want)
		}
	}
}
