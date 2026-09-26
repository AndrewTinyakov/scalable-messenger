package rabbitmq

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"messenger/ws/internal/protocol"
)

const Exchange = "messenger.commands"
const Partitions = 4

var ErrUnknownOutcome = errors.New("publish outcome unknown")
var ErrRejected = errors.New("publish rejected")

type Publisher struct {
	conn           *amqp.Connection
	capacity       chan struct{}
	confirmTimeout time.Duration
	mu             sync.RWMutex
	closed         bool
}

func New(url string, concurrency int, confirmTimeout time.Duration) (*Publisher, error) {
	conn, err := amqp.Dial(url)
	if err != nil {
		return nil, fmt.Errorf("connect RabbitMQ: %w", err)
	}
	p := &Publisher{conn: conn, capacity: make(chan struct{}, concurrency), confirmTimeout: confirmTimeout}
	if err := p.declare(); err != nil {
		conn.Close()
		return nil, err
	}
	return p, nil
}

func (p *Publisher) declare() error {
	ch, err := p.conn.Channel()
	if err != nil {
		return err
	}
	defer ch.Close()
	if err := ch.ExchangeDeclare(Exchange, "direct", true, false, false, false, nil); err != nil {
		return fmt.Errorf("declare exchange: %w", err)
	}
	for i := 0; i < Partitions; i++ {
		name := fmt.Sprintf("messenger.send.%d", i)
		args := amqp.Table{"x-queue-type": "quorum", "x-max-length": int32(10000), "x-overflow": "reject-publish"}
		if _, err := ch.QueueDeclare(name, true, false, false, false, args); err != nil {
			return fmt.Errorf("declare %s: %w", name, err)
		}
		if err := ch.QueueBind(name, name, Exchange, false, nil); err != nil {
			return fmt.Errorf("bind %s: %w", name, err)
		}
	}
	return nil
}

func Route(conversationID string) string {
	h := fnv.New32a()
	_, _ = h.Write([]byte(conversationID))
	return fmt.Sprintf("messenger.send.%d", h.Sum32()%Partitions)
}

func (p *Publisher) Publish(ctx context.Context, command protocol.SendCommand) error {
	select {
	case p.capacity <- struct{}{}:
		defer func() { <-p.capacity }()
	case <-ctx.Done():
		return ctx.Err()
	}
	p.mu.RLock()
	if p.closed {
		p.mu.RUnlock()
		return errors.New("publisher closed")
	}
	conn := p.conn
	p.mu.RUnlock()
	ch, err := conn.Channel()
	if err != nil {
		return fmt.Errorf("open publish channel: %w", err)
	}
	defer ch.Close()
	if err := ch.Confirm(false); err != nil {
		return fmt.Errorf("enable confirms: %w", err)
	}
	confirms := ch.NotifyPublish(make(chan amqp.Confirmation, 1))
	returns := ch.NotifyReturn(make(chan amqp.Return, 1))
	body, err := json.Marshal(command.Wire())
	if err != nil {
		return err
	}
	if err := ch.PublishWithContext(ctx, Exchange, Route(command.ConversationID), true, false, amqp.Publishing{ContentType: "application/json", DeliveryMode: amqp.Persistent, Body: body, MessageId: command.RequestID, Timestamp: time.Now().UTC()}); err != nil {
		return fmt.Errorf("publish command: %w", err)
	}
	timer := time.NewTimer(p.confirmTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", ErrUnknownOutcome, ctx.Err())
		case <-timer.C:
			return ErrUnknownOutcome
		case returned := <-returns:
			return fmt.Errorf("%w: unroutable %d %s", ErrRejected, returned.ReplyCode, returned.ReplyText)
		case confirmation, ok := <-confirms:
			if !ok {
				return ErrUnknownOutcome
			}
			select {
			case returned := <-returns:
				return fmt.Errorf("%w: unroutable %d %s", ErrRejected, returned.ReplyCode, returned.ReplyText)
			default:
			}
			if !confirmation.Ack {
				return ErrRejected
			}
			return nil
		}
	}
}

func (p *Publisher) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	return p.conn.Close()
}
