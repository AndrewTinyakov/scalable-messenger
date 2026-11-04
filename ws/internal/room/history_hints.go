package room

import (
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

func coalesceHistoryHints(items []redisroom.Live) []redisroom.Live {
	result := make([]redisroom.Live, 0, len(items))
	pending := make(map[string]int)
	for _, item := range items {
		if item.Event.Type != protocol.EventHistoryChanged {
			clear(pending)
			result = append(result, item)
			continue
		}
		if index, ok := pending[item.Event.ChatID]; ok {
			previous := result[index].Event
			item.Event.Sequence = maximumDecimal(previous.Sequence, item.Event.Sequence)
			item.Event.MutationRevision = maximumDecimal(previous.MutationRevision, item.Event.MutationRevision)
			item.Event.VisibilityRevision = maximumDecimal(previous.VisibilityRevision, item.Event.VisibilityRevision)
			result[index] = redisroom.Live{}
		}
		pending[item.Event.ChatID] = len(result)
		result = append(result, item)
	}
	kept := result[:0]
	for _, item := range result {
		if item.Event.Type != "" {
			kept = append(kept, item)
		}
	}
	return kept
}

func maximumDecimal(left, right string) string {
	if len(left) > len(right) || len(left) == len(right) && left > right {
		return left
	}
	return right
}
