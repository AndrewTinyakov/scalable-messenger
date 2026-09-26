package messaging

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

func TestQueueArgumentsMatchKotlinTopology(t *testing.T) {
	if Exchange != "messenger.commands" || DeadExchange != "messenger.commands.dead" || DeadQueue != "messenger.send.dead" || Partitions != 4 {
		t.Fatal("command topology names changed")
	}
	args := QueueArguments()
	want := map[string]any{
		"x-queue-type":              "quorum",
		"x-max-length":              int32(10000),
		"x-overflow":                "reject-publish",
		"x-delivery-limit":          int32(20),
		"x-dead-letter-exchange":    DeadExchange,
		"x-dead-letter-routing-key": DeadQueue,
	}
	if len(args) != len(want) {
		t.Fatalf("queue argument count = %d, want %d", len(args), len(want))
	}
	for key, value := range want {
		if args[key] != value {
			t.Errorf("%s = %v, want %v", key, args[key], value)
		}
	}
}
