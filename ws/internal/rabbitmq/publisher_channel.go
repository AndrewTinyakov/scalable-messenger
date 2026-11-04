package rabbitmq

import (
	"context"
	"fmt"
	"net"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"messenger/ws/internal/monitoring"
)

type publishChannel struct {
	connection *amqp.Connection
	transport  net.Conn
	channel    *amqp.Channel
	confirms   <-chan amqp.Confirmation
	returns    <-chan amqp.Return
	closed     <-chan *amqp.Error
}

func (p *Publisher) newChannel(ctx context.Context) (_ *publishChannel, result error) {
	started := time.Now()
	defer func() {
		if metrics := p.metrics.Load(); metrics != nil {
			outcome := monitoring.PublishStageReady
			if result != nil {
				outcome = monitoring.PublishStageFailed
			}
			metrics.ObservePublishChannelAcquisition(time.Since(started), outcome)
		}
	}()
	p.mu.Lock()
	start := p.nextURL
	p.nextURL = (p.nextURL + 1) % len(p.urls)
	p.mu.Unlock()
	var last error
	for i := range p.urls {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		attemptCtx := ctx
		cancel := func() {}
		if deadline, ok := ctx.Deadline(); ok {
			attemptCtx, cancel = context.WithTimeout(ctx, time.Until(deadline)/time.Duration(len(p.urls)-i))
		}
		p.recordBroker("rabbit_connect_attempt")
		slot, err := connectChannel(attemptCtx, p.urls[(start+i)%len(p.urls)], p.itemLimit)
		cancel()
		if err == nil {
			p.recordBroker("rabbit_connected")
			return slot, nil
		}
		p.recordBroker("rabbit_connect_failed")
		last = err
	}
	return nil, fmt.Errorf("connect RabbitMQ: %w", last)
}

func connectChannel(ctx context.Context, url string, capacity int) (_ *publishChannel, result error) {
	slot := &publishChannel{}
	var stop func()
	defer func() {
		if stop != nil {
			stop()
		}
		if result != nil {
			slot.close()
		}
	}()
	conn, err := amqp.DialConfig(url, amqp.Config{Dial: func(network, address string) (net.Conn, error) {
		transport, err := (&net.Dialer{}).DialContext(ctx, network, address)
		if err != nil {
			return nil, err
		}
		slot.transport = transport
		stop = interruptTransport(ctx, transport)
		return transport, nil
	}})
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, err
	}
	slot.connection = conn
	if err := declare(conn); err != nil {
		return nil, err
	}
	ch, err := conn.Channel()
	if err != nil {
		return nil, err
	}
	slot.channel = ch
	if err := ch.Confirm(false); err != nil {
		return nil, fmt.Errorf("enable confirms: %w", err)
	}
	slot.confirms = ch.NotifyPublish(make(chan amqp.Confirmation, capacity))
	slot.returns = ch.NotifyReturn(make(chan amqp.Return, capacity))
	slot.closed = ch.NotifyClose(make(chan *amqp.Error, 1))
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return slot, nil
}

func interruptTransport(ctx context.Context, transport net.Conn) func() {
	done := make(chan struct{})
	stop := context.AfterFunc(ctx, func() {
		defer close(done)
		_ = transport.Close()
	})
	return func() {
		if !stop() {
			<-done
		}
	}
}

func (slot *publishChannel) close() {
	if slot == nil {
		return
	}
	if slot.transport != nil {
		_ = slot.transport.Close()
	}
	if slot.connection != nil {
		_ = slot.connection.CloseDeadline(time.Now())
	}
}
