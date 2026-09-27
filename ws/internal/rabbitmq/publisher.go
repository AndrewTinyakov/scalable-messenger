package rabbitmq

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"
	"messenger/ws/internal/messagecodec"
	"messenger/ws/internal/messaging"
	"messenger/ws/internal/protocol"
)

var ErrUnknownOutcome = errors.New("publish outcome unknown")
var ErrRejected = errors.New("publish rejected")

type publishChannel struct {
	channel  *amqp.Channel
	confirms <-chan amqp.Confirmation
	returns  <-chan amqp.Return
	closed   <-chan *amqp.Error
}

type Publisher struct {
	urls           []string
	conn           *amqp.Connection
	nextURL        int
	channels       chan *publishChannel
	confirmTimeout time.Duration
	mu             sync.Mutex
	closed         bool
}

func New(urls []string, concurrency int, confirmTimeout time.Duration) (*Publisher, error) {
	if len(urls) == 0 || concurrency < 1 || confirmTimeout <= 0 {
		return nil, errors.New("invalid RabbitMQ publisher configuration")
	}
	p := &Publisher{urls: urls, channels: make(chan *publishChannel, concurrency), confirmTimeout: confirmTimeout}
	for i := 0; i < concurrency; i++ {
		p.channels <- nil
	}
	p.mu.Lock()
	err := p.connect()
	p.mu.Unlock()
	if err != nil {
		return nil, err
	}
	return p, nil
}

func (p *Publisher) connect() error {
	var last error
	for i := 0; i < len(p.urls); i++ {
		index := (p.nextURL + i) % len(p.urls)
		conn, err := amqp.Dial(p.urls[index])
		if err == nil {
			err = declare(conn)
			if err == nil {
				p.conn = conn
				p.nextURL = (index + 1) % len(p.urls)
				return nil
			}
			_ = conn.Close()
		}
		last = err
	}
	return fmt.Errorf("connect RabbitMQ: %w", last)
}

func (p *Publisher) newChannel() (*publishChannel, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.closed {
		return nil, errors.New("publisher closed")
	}
	if p.conn == nil || p.conn.IsClosed() {
		if err := p.connect(); err != nil {
			return nil, err
		}
	}
	ch, err := p.conn.Channel()
	if err != nil {
		_ = p.conn.Close()
		p.conn = nil
		if err = p.connect(); err != nil {
			return nil, err
		}
		ch, err = p.conn.Channel()
		if err != nil {
			return nil, err
		}
	}
	if err := ch.Confirm(false); err != nil {
		_ = ch.Close()
		return nil, fmt.Errorf("enable confirms: %w", err)
	}
	return &publishChannel{
		channel:  ch,
		confirms: ch.NotifyPublish(make(chan amqp.Confirmation, 1)),
		returns:  ch.NotifyReturn(make(chan amqp.Return, 1)),
		closed:   ch.NotifyClose(make(chan *amqp.Error, 1)),
	}, nil
}

func (p *Publisher) Publish(ctx context.Context, command protocol.SendCommand) error {
	body, err := messagecodec.Encode(command.Wire())
	if err != nil {
		return err
	}
	var slot *publishChannel
	select {
	case slot = <-p.channels:
	case <-ctx.Done():
		return ctx.Err()
	}
	keep := false
	defer func() {
		if slot != nil && !keep {
			_ = slot.channel.Close()
			slot = nil
		}
		p.channels <- slot
	}()
	if slot == nil || slot.channel.IsClosed() {
		slot, err = p.newChannel()
		if err != nil {
			return err
		}
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := slot.channel.PublishWithContext(ctx, messaging.Exchange, messaging.RouteForTarget(command.SenderID, command.ChatID, command.RecipientID), true, false, amqp.Publishing{
		ContentType: "application/json", DeliveryMode: amqp.Persistent, Body: body, MessageId: command.RequestID, Timestamp: time.Now().UTC(),
	}); err != nil {
		return fmt.Errorf("%w: publish command: %v", ErrUnknownOutcome, err)
	}
	timer := time.NewTimer(p.confirmTimeout)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return fmt.Errorf("%w: %v", ErrUnknownOutcome, ctx.Err())
		case <-timer.C:
			return ErrUnknownOutcome
		case returned := <-slot.returns:
			return fmt.Errorf("%w: unroutable %d %s", ErrRejected, returned.ReplyCode, returned.ReplyText)
		case confirmation, ok := <-slot.confirms:
			if !ok {
				return ErrUnknownOutcome
			}
			select {
			case returned := <-slot.returns:
				return fmt.Errorf("%w: unroutable %d %s", ErrRejected, returned.ReplyCode, returned.ReplyText)
			default:
			}
			if !confirmation.Ack {
				return ErrRejected
			}
			keep = true
			return nil
		case <-slot.closed:
			return ErrUnknownOutcome
		}
	}
}

func (p *Publisher) Close() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.closed = true
	if p.conn != nil {
		return p.conn.Close()
	}
	return nil
}
