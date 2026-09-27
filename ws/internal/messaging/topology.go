package messaging

import (
	"fmt"
	"hash/fnv"
)

const Exchange = "messenger.commands"
const DeadExchange = "messenger.commands.dead"
const DeadQueue = "messenger.send.dead"
const Partitions = 4
const QueueLength = 10000
const DeliveryLimit = 20

func Route(key string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(key))
	return fmt.Sprintf("messenger.send.%d", h.Sum32()%Partitions)
}

func RouteForTarget(senderID, chatID, recipientID string) string {
	if chatID != "" {
		return Route(chatID)
	}
	if senderID > recipientID {
		senderID, recipientID = recipientID, senderID
	}
	return Route(senderID + ":" + recipientID)
}

func QueueName(partition int) string { return fmt.Sprintf("messenger.send.%d", partition) }

func QueueArguments() map[string]any {
	return map[string]any{
		"x-queue-type":                "quorum",
		"x-quorum-initial-group-size": int32(3),
		"x-max-length":                int32(QueueLength),
		"x-overflow":                  "reject-publish",
		"x-delivery-limit":            int32(DeliveryLimit),
		"x-dead-letter-exchange":      DeadExchange,
		"x-dead-letter-routing-key":   DeadQueue,
		"x-dead-letter-strategy":      "at-least-once",
		"x-delayed-retry-type":        "failed",
		"x-delayed-retry-min":         int32(1000),
		"x-delayed-retry-max":         int32(30000),
	}
}

func DeadQueueArguments() map[string]any {
	return map[string]any{
		"x-queue-type":                "quorum",
		"x-quorum-initial-group-size": int32(3),
		"x-delivery-limit":            int32(-1),
		"x-delayed-retry-type":        "failed",
		"x-delayed-retry-min":         int32(1000),
		"x-delayed-retry-max":         int32(30000),
	}
}
