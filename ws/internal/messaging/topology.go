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

func Route(conversationID string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(conversationID))
	return fmt.Sprintf("messenger.send.%d", h.Sum32()%Partitions)
}

func QueueName(partition int) string { return fmt.Sprintf("messenger.send.%d", partition) }

func QueueArguments() map[string]any {
	return map[string]any{
		"x-queue-type":              "quorum",
		"x-max-length":              int32(QueueLength),
		"x-overflow":                "reject-publish",
		"x-delivery-limit":          int32(DeliveryLimit),
		"x-dead-letter-exchange":    DeadExchange,
		"x-dead-letter-routing-key": DeadQueue,
	}
}
