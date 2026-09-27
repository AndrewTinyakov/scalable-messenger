package redisroom

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

type slotOwner struct {
	start, end int
	address    string
}

// address is called with subscriptionHub.mu held. Redis Cluster's sharded
// Pub/Sub must use a node serving the channel's hash slot.
func (h *subscriptionHub) address(ctx context.Context, room string) (string, error) {
	cluster, ok := h.owner.redis.(*redis.ClusterClient)
	if !ok {
		return "standalone", nil
	}
	if h.slots == nil {
		slots, err := cluster.ClusterSlots(ctx).Result()
		if err != nil {
			return "", fmt.Errorf("Redis Cluster slots: %w", err)
		}
		if !validClusterSlots(slots) {
			return "", errors.New("incomplete Redis Cluster topology")
		}
		h.slots = make([]slotOwner, 0, len(slots))
		for _, slot := range slots {
			h.slots = append(h.slots, slotOwner{slot.Start, slot.End, slot.Nodes[0].Addr})
		}
	}
	slot := roomSlot(room)
	for _, owner := range h.slots {
		if slot >= owner.start && slot <= owner.end {
			return owner.address, nil
		}
	}
	return "", fmt.Errorf("no Redis Cluster owner for slot %d", slot)
}

// Channel(room) hashes the room name inside its braces. Redis Cluster uses
// CRC16/XMODEM modulo 16384 for the hash slot.
func roomSlot(room string) int {
	var crc uint16
	for i := 0; i < len(room); i++ {
		crc ^= uint16(room[i]) << 8
		for bit := 0; bit < 8; bit++ {
			if crc&0x8000 != 0 {
				crc = crc<<1 ^ 0x1021
			} else {
				crc <<= 1
			}
		}
	}
	return int(crc) % 16384
}
