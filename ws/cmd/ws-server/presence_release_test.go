package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"testing"
)

type recordingPresence struct {
	steps *[]string
	err   error
}

func (p recordingPresence) RemoveGateway(_ context.Context, gateway string) error {
	*p.steps = append(*p.steps, "remove "+gateway)
	return p.err
}

func TestReleaseGatewayPresenceStopsWritersBeforeClearingTheFinalIdentity(t *testing.T) {
	for _, removeErr := range []error{nil, errors.New("redis down")} {
		var steps []string
		identity := "before-renewal"
		stopWriters := func() {
			steps = append(steps, "stop writers")
			identity = "after-renewal"
		}
		gateway := func() string { return identity }
		releaseGatewayPresence(context.Background(), stopWriters, recordingPresence{steps: &steps, err: removeErr}, gateway, slog.New(slog.NewTextHandler(io.Discard, nil)))
		if len(steps) != 2 || steps[0] != "stop writers" || steps[1] != "remove after-renewal" {
			t.Fatalf("steps = %v, want writers stopped then the final identity cleared", steps)
		}
	}
}
