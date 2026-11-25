package room

import (
	"testing"

	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

func TestReplayCoalescesRecoveryHintsWithoutCrossingControlEvents(t *testing.T) {
	hint := func(chat, sequence, revision, position string) redisroom.Live {
		return redisroom.Live{StreamID: position, Event: protocol.Event{Type: protocol.EventHistoryChanged, ChatID: chat, Sequence: sequence, Seq: revision, StreamID: position}}
	}
	items := []redisroom.Live{
		hint("a", "9007199254740993", "9", "1-0"),
		hint("b", "2", "0", "2-0"),
		hint("a", "8", "10", "3-0"),
		{StreamID: "4-0", Event: protocol.Event{Type: protocol.EventMemberRemoved}},
		hint("a", "10", "11", "5-0"),
	}
	result := coalesceHistoryHints(items)
	if len(result) != 4 || result[0].Event.ChatID != "b" || result[1].StreamID != "3-0" || result[1].Event.Sequence != "9007199254740993" || result[1].Event.Seq != "10" || result[2].Event.Type != protocol.EventMemberRemoved || result[3].StreamID != "5-0" {
		t.Fatalf("unexpected replay: %+v", result)
	}
}
