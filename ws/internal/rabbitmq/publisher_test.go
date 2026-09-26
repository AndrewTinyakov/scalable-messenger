package rabbitmq

import "testing"

func TestRouteStablePartition(t *testing.T) {
	cases := []struct{ id, want string }{
		{"01ARZ3NDEKTSV4RRFFQ69G5FAV", "messenger.send.0"},
		{"01ARZ3NDEKTSV4RRFFQ69G5FAW", "messenger.send.3"},
	}
	for _, tc := range cases {
		if got := Route(tc.id); got != tc.want {
			t.Errorf("Route(%q) = %q, want %q", tc.id, got, tc.want)
		}
	}
}
