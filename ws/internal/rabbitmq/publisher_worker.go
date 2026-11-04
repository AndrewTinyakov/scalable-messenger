package rabbitmq

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"

	amqp "github.com/rabbitmq/amqp091-go"

	"messenger/ws/internal/messaging"
	"messenger/ws/internal/monitoring"
)

type outstandingPublish struct {
	request     *publishRequest
	correlation string
	deadline    time.Time
	started     time.Time
	rejected    error
}

type publishWorker struct {
	publisher *Publisher
	jobs      chan *publishRequest
	slot      *publishChannel
}

func (worker *publishWorker) run() {
	p := worker.publisher
	defer p.owned.Done()
	pending := make(map[uint64]*outstandingPublish)
	byCorrelation := make(map[string]*outstandingPublish)
	var stopTransport func()
	if worker.slot != nil {
		stopTransport = interruptTransport(p.ctx, worker.slot.transport)
	}
	finishPublish := func(publish *outstandingPublish, err error) {
		if metrics := p.metrics.Load(); metrics != nil {
			outcome := monitoring.PublishConfirmationConfirmed
			if errors.Is(err, ErrRejected) {
				outcome = monitoring.PublishConfirmationRejected
			} else if err != nil {
				outcome = monitoring.PublishConfirmationUnknown
			}
			metrics.ObservePublishConfirmation(time.Since(publish.started), outcome)
		}
		p.finish(publish.request, err)
	}
	fail := func(err error) {
		if worker.slot != nil && p.ctx.Err() == nil {
			p.recordBroker("rabbit_channel_failed")
		}
		if stopTransport != nil {
			stopTransport()
			stopTransport = nil
		}
		worker.slot.close()
		worker.slot = nil
		for _, publish := range pending {
			finishPublish(publish, err)
		}
		clear(pending)
		clear(byCorrelation)
	}
	defer func() {
		fail(fmt.Errorf("%w: %w", ErrUnknownOutcome, context.Canceled))
		for {
			select {
			case request := <-worker.jobs:
				p.observeQueueWait(request, monitoring.PublishStageFailed)
				p.finish(request, ErrClosed)
			default:
				return
			}
		}
	}()
	ticker := time.NewTicker(min(100*time.Millisecond, p.confirmTimeout))
	defer ticker.Stop()
	recordReturn := func(returned amqp.Return) {
		if publish := byCorrelation[returned.CorrelationId]; publish != nil {
			publish.rejected = fmt.Errorf("%w: unroutable %d %s", ErrRejected, returned.ReplyCode, returned.ReplyText)
		}
	}
	for {
		var confirms <-chan amqp.Confirmation
		var returns <-chan amqp.Return
		var closed <-chan *amqp.Error
		if worker.slot != nil {
			confirms, returns, closed = worker.slot.confirms, worker.slot.returns, worker.slot.closed
		}
		select {
		case <-p.ctx.Done():
			return
		case request := <-worker.jobs:
			if err := request.ctx.Err(); err != nil || request.state.Load() == requestCancelled {
				p.observeQueueWait(request, monitoring.PublishStageFailed)
				p.finish(request, request.ctx.Err())
				continue
			}
			p.observeQueueWait(request, monitoring.PublishStageReady)
			if worker.slot == nil {
				setupCtx, cancel := context.WithTimeout(p.ctx, p.confirmTimeout)
				slot, err := p.newChannel(setupCtx)
				cancel()
				if err != nil {
					p.finish(request, err)
					continue
				}
				worker.slot = slot
				stopTransport = interruptTransport(p.ctx, slot.transport)
			}
			if !request.state.CompareAndSwap(requestQueued, requestPublishing) {
				p.finish(request, request.ctx.Err())
				continue
			}
			tag := worker.slot.channel.GetNextPublishSeqNo()
			correlation := strconv.FormatUint(p.sequence.Add(1), 10)
			publish := &outstandingPublish{request: request, correlation: correlation, deadline: time.Now().Add(p.confirmTimeout)}
			pending[tag] = publish
			byCorrelation[correlation] = publish
			_ = worker.slot.transport.SetWriteDeadline(publish.deadline)
			publish.started = time.Now()
			err := worker.slot.channel.PublishWithContext(p.ctx, messaging.Exchange, request.route, true, false, amqp.Publishing{
				ContentType: "application/json", DeliveryMode: amqp.Persistent, Body: request.body,
				MessageId: request.messageID, CorrelationId: correlation, Timestamp: time.Now().UTC(),
			})
			_ = worker.slot.transport.SetWriteDeadline(time.Time{})
			if err != nil {
				fail(fmt.Errorf("%w: publish command: %w", ErrUnknownOutcome, err))
			}
		case returned, ok := <-returns:
			if !ok {
				fail(ErrUnknownOutcome)
				continue
			}
			recordReturn(returned)
		case confirmation, ok := <-confirms:
			if !ok {
				fail(ErrUnknownOutcome)
				continue
			}
			valid := true
		drainReturns:
			for {
				select {
				case returned, ok := <-returns:
					if !ok {
						valid = false
						break drainReturns
					}
					recordReturn(returned)
				default:
					break drainReturns
				}
			}
			if !valid {
				fail(ErrUnknownOutcome)
				continue
			}
			if publish := pending[confirmation.DeliveryTag]; publish != nil {
				err := publish.rejected
				if !confirmation.Ack {
					err = ErrRejected
				}
				delete(pending, confirmation.DeliveryTag)
				delete(byCorrelation, publish.correlation)
				finishPublish(publish, err)
			}
		case <-closed:
			fail(ErrUnknownOutcome)
		case now := <-ticker.C:
			for _, publish := range pending {
				if !now.Before(publish.deadline) {
					fail(fmt.Errorf("%w: %w", ErrUnknownOutcome, context.DeadlineExceeded))
					break
				}
			}
		}
	}
}
