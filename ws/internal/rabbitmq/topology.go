package rabbitmq

import (
	"fmt"

	amqp "github.com/rabbitmq/amqp091-go"
	"messenger/ws/internal/messaging"
)

func declare(conn *amqp.Connection) error {
	ch, err := conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()
	if err := ch.ExchangeDeclare(messaging.Exchange, "direct", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare exchange: %w", err)
	}
	if err := ch.ExchangeDeclare(messaging.DeadExchange, "direct", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare dead exchange: %w", err)
	}
	if _, err := ch.QueueDeclare(messaging.DeadQueue, true, false, false, false, amqp.Table(messaging.DeadQueueArguments())); err != nil {
		return fmt.Errorf("declare dead queue: %w", err)
	}
	if err := ch.QueueBind(messaging.DeadQueue, messaging.DeadQueue, messaging.DeadExchange, false, nil); err != nil {
		return fmt.Errorf("bind dead queue: %w", err)
	}
	for i := 0; i < messaging.Partitions; i++ {
		name := messaging.QueueName(i)
		args := amqp.Table(messaging.QueueArguments())
		if _, err := ch.QueueDeclare(name, true, false, false, false, args); err != nil {
			return fmt.Errorf("declare %s: %w", name, err)
		}
		if err := ch.QueueBind(name, name, messaging.Exchange, false, nil); err != nil {
			return fmt.Errorf("bind %s: %w", name, err)
		}
	}
	return nil
}
