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
	publisher     *Publisher
	jobs          chan *publishRequest
	slot          *publishChannel
	pending       map[uint64]*outstandingPublish
	byCorrelation map[string]*outstandingPublish
	stopTransport func()
}

func (worker *publishWorker) run() {
	p := worker.publisher
	defer p.owned.Done()
	worker.pending = make(map[uint64]*outstandingPublish)
	worker.byCorrelation = make(map[string]*outstandingPublish)
	if worker.slot != nil {
		worker.stopTransport = interruptTransport(p.ctx, worker.slot.transport)
	}
	defer worker.shutdown()
	ticker := time.NewTicker(min(100*time.Millisecond, p.confirmTimeout))
	defer ticker.Stop()
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
			worker.accept(request)
		case returned, ok := <-returns:
			if !ok {
				worker.fail(ErrUnknownOutcome)
				continue
			}
			worker.recordReturn(returned)
		case confirmation, ok := <-confirms:
			if !ok || !worker.drainReturns(returns) {
				worker.fail(ErrUnknownOutcome)
				continue
			}
			worker.confirm(confirmation)
		case <-closed:
			worker.fail(ErrUnknownOutcome)
		case now := <-ticker.C:
			worker.expire(now)
		}
	}
}

func (worker *publishWorker) shutdown() {
	p := worker.publisher
	worker.fail(fmt.Errorf("%w: %w", ErrUnknownOutcome, context.Canceled))
	for {
		select {
		case request := <-worker.jobs:
			p.observeQueueWait(request, monitoring.PublishStageFailed)
			p.finish(request, ErrClosed)
		default:
			return
		}
	}
}

func (worker *publishWorker) accept(request *publishRequest) {
	p := worker.publisher
	if err := request.ctx.Err(); err != nil || request.state.Load() == requestCancelled {
		p.observeQueueWait(request, monitoring.PublishStageFailed)
		p.finish(request, request.ctx.Err())
		return
	}
	p.observeQueueWait(request, monitoring.PublishStageReady)
	if worker.slot == nil {
		setupCtx, cancel := context.WithTimeout(p.ctx, p.confirmTimeout)
		slot, err := p.newChannel(setupCtx)
		cancel()
		if err != nil {
			p.finish(request, err)
			return
		}
		worker.slot = slot
		worker.stopTransport = interruptTransport(p.ctx, slot.transport)
	}
	if !request.state.CompareAndSwap(requestQueued, requestPublishing) {
		p.finish(request, request.ctx.Err())
		return
	}
	worker.publish(request)
}

func (worker *publishWorker) publish(request *publishRequest) {
	p := worker.publisher
	tag := worker.slot.channel.GetNextPublishSeqNo()
	correlation := strconv.FormatUint(p.sequence.Add(1), 10)
	publish := &outstandingPublish{request: request, correlation: correlation, deadline: time.Now().Add(p.confirmTimeout)}
	worker.pending[tag] = publish
	worker.byCorrelation[correlation] = publish
	_ = worker.slot.transport.SetWriteDeadline(publish.deadline)
	publish.started = time.Now()
	err := worker.slot.channel.PublishWithContext(p.ctx, messaging.Exchange, request.route, true, false, amqp.Publishing{
		ContentType: "application/json", DeliveryMode: amqp.Persistent, Body: request.body,
		MessageId: request.messageID, CorrelationId: correlation, Timestamp: time.Now().UTC(),
	})
	_ = worker.slot.transport.SetWriteDeadline(time.Time{})
	if err != nil {
		worker.fail(fmt.Errorf("%w: publish command: %w", ErrUnknownOutcome, err))
	}
}

func (worker *publishWorker) confirm(confirmation amqp.Confirmation) {
	publish := worker.pending[confirmation.DeliveryTag]
	if publish == nil {
		return
	}
	err := publish.rejected
	if !confirmation.Ack {
		err = ErrRejected
	}
	delete(worker.pending, confirmation.DeliveryTag)
	delete(worker.byCorrelation, publish.correlation)
	worker.finish(publish, err)
}

func (worker *publishWorker) recordReturn(returned amqp.Return) {
	if publish := worker.byCorrelation[returned.CorrelationId]; publish != nil {
		publish.rejected = fmt.Errorf("%w: unroutable %d %s", ErrRejected, returned.ReplyCode, returned.ReplyText)
	}
}

func (worker *publishWorker) drainReturns(returns <-chan amqp.Return) bool {
	for {
		select {
		case returned, ok := <-returns:
			if !ok {
				return false
			}
			worker.recordReturn(returned)
		default:
			return true
		}
	}
}

func (worker *publishWorker) expire(now time.Time) {
	for _, publish := range worker.pending {
		if !now.Before(publish.deadline) {
			worker.fail(fmt.Errorf("%w: %w", ErrUnknownOutcome, context.DeadlineExceeded))
			return
		}
	}
}

func (worker *publishWorker) finish(publish *outstandingPublish, err error) {
	p := worker.publisher
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

func (worker *publishWorker) fail(err error) {
	p := worker.publisher
	if worker.slot != nil && p.ctx.Err() == nil {
		p.recordBroker("rabbit_channel_failed")
	}
	if worker.stopTransport != nil {
		worker.stopTransport()
		worker.stopTransport = nil
	}
	worker.slot.close()
	worker.slot = nil
	for _, publish := range worker.pending {
		worker.finish(publish, err)
	}
	clear(worker.pending)
	clear(worker.byCorrelation)
}
