package rabbitmq

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"time"

	"messenger/ws/internal/messagecodec"
	"messenger/ws/internal/messaging"
	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
)

var ErrUnknownOutcome = errors.New("publish outcome unknown")
var ErrRejected = errors.New("publish rejected")
var ErrClosed = errors.New("publisher closed")

const maxPublishBodyBytes = 64 << 10
const maxPublisherBytes = 8 << 20

const (
	requestQueued int32 = iota
	requestPublishing
	requestCancelled
)

type publishRequest struct {
	ctx       context.Context
	route     string
	messageID string
	body      []byte
	bytes     int
	result    chan error
	state     atomic.Int32
	queuedAt  time.Time
}

type publisherState uint8

const (
	publisherOpen publisherState = iota
	publisherClosed
)

type Publisher struct {
	metrics        atomic.Pointer[monitoring.Metrics]
	urls           []string
	nextURL        int
	workers        []*publishWorker
	confirmTimeout time.Duration
	itemLimit      int
	byteLimit      int
	mu             sync.Mutex
	state          publisherState
	pendingItems   int
	pendingBytes   int
	capacity       chan struct{}
	ctx            context.Context
	cancel         context.CancelFunc
	active         sync.WaitGroup
	owned          sync.WaitGroup
	sequence       atomic.Uint64
	nextWorker     atomic.Uint64
	closeOnce      sync.Once
}

func New(urls []string, concurrency int, confirmTimeout time.Duration) (*Publisher, error) {
	if len(urls) == 0 || concurrency < 1 || confirmTimeout <= 0 {
		return nil, errors.New("invalid RabbitMQ publisher configuration")
	}
	ctx, cancel := context.WithCancel(context.Background())
	byteLimit := maxPublisherBytes
	if concurrency < maxPublisherBytes/maxPublishBodyBytes {
		byteLimit = concurrency * maxPublishBodyBytes
	}
	p := &Publisher{
		urls: append([]string(nil), urls...), confirmTimeout: confirmTimeout,
		itemLimit: concurrency, byteLimit: byteLimit, capacity: make(chan struct{}), ctx: ctx, cancel: cancel,
	}
	setupCtx, stop := context.WithTimeout(ctx, confirmTimeout)
	defer stop()
	slot, err := p.newChannel(setupCtx)
	if err != nil {
		cancel()
		return nil, err
	}
	for i := range min(3, concurrency) {
		worker := &publishWorker{publisher: p, jobs: make(chan *publishRequest, concurrency)}
		if i == 0 {
			worker.connect(slot)
		}
		p.workers = append(p.workers, worker)
	}
	for _, worker := range p.workers {
		p.owned.Add(1)
		go worker.run()
	}
	return p, nil
}

func (p *Publisher) Publish(ctx context.Context, command protocol.SendCommand) error {
	p.mu.Lock()
	if p.state == publisherClosed {
		p.mu.Unlock()
		return ErrClosed
	}
	p.active.Add(1)
	p.mu.Unlock()
	defer p.active.Done()
	ctx, cancel := context.WithTimeout(ctx, p.confirmTimeout)
	defer cancel()
	if len(command.Body) > maxPublishBodyBytes {
		return fmt.Errorf("%w: command exceeds publication byte limit", ErrRejected)
	}
	request := &publishRequest{
		ctx: ctx, route: messaging.RouteForTarget(command.SenderID, command.ChatID, command.RecipientID),
		messageID: command.RequestID, bytes: maxPublishBodyBytes, result: make(chan error, 1),
	}
	reserveStarted := time.Now()
	reserveErr := p.reserve(request)
	if metrics := p.metrics.Load(); metrics != nil {
		outcome := monitoring.PublishStageReady
		if reserveErr != nil {
			outcome = monitoring.PublishStageFailed
		}
		metrics.ObservePublishCapacityWait(time.Since(reserveStarted), outcome)
	}
	if reserveErr != nil {
		return reserveErr
	}
	body, err := messagecodec.Encode(command.Wire())
	if err != nil {
		p.finish(request, err)
		return err
	}
	if len(body) > maxPublishBodyBytes {
		err := fmt.Errorf("%w: command exceeds publication byte limit", ErrRejected)
		p.finish(request, err)
		return err
	}
	request.body = body
	p.mu.Lock()
	p.pendingBytes -= request.bytes - len(body)
	request.bytes = len(body)
	close(p.capacity)
	p.capacity = make(chan struct{})
	if p.state == publisherClosed {
		p.mu.Unlock()
		p.finish(request, ErrClosed)
		return ErrClosed
	}
	worker := p.workers[(p.nextWorker.Add(1)-1)%uint64(len(p.workers))]
	request.queuedAt = time.Now()
	worker.jobs <- request
	p.mu.Unlock()
	select {
	case err := <-request.result:
		return err
	case <-ctx.Done():
		if request.state.CompareAndSwap(requestQueued, requestCancelled) {
			return ctx.Err()
		}
		return fmt.Errorf("%w: %w", ErrUnknownOutcome, ctx.Err())
	case <-p.ctx.Done():
		if request.state.CompareAndSwap(requestQueued, requestCancelled) {
			return ErrClosed
		}
		return fmt.Errorf("%w: %w", ErrUnknownOutcome, p.ctx.Err())
	}
}

func (p *Publisher) reserve(request *publishRequest) error {
	for {
		p.mu.Lock()
		if p.state == publisherClosed {
			p.mu.Unlock()
			return ErrClosed
		}
		if err := request.ctx.Err(); err != nil {
			p.mu.Unlock()
			return err
		}
		if p.pendingItems < p.itemLimit && p.pendingBytes+request.bytes <= p.byteLimit {
			p.pendingItems++
			p.pendingBytes += request.bytes
			p.mu.Unlock()
			return nil
		}
		capacity := p.capacity
		p.mu.Unlock()
		select {
		case <-capacity:
		case <-request.ctx.Done():
			return request.ctx.Err()
		case <-p.ctx.Done():
			return ErrClosed
		}
	}
}

func (p *Publisher) finish(request *publishRequest, err error) {
	p.mu.Lock()
	p.pendingItems--
	p.pendingBytes -= request.bytes
	close(p.capacity)
	p.capacity = make(chan struct{})
	p.mu.Unlock()
	request.result <- err
}

func (p *Publisher) Close() error {
	p.closeOnce.Do(func() {
		p.mu.Lock()
		p.state = publisherClosed
		p.cancel()
		p.mu.Unlock()
		p.owned.Wait()
		p.active.Wait()
	})
	return nil
}

func (p *Publisher) SetMetrics(metrics *monitoring.Metrics) { p.metrics.Store(metrics) }
func (p *Publisher) recordBroker(result string) {
	if metrics := p.metrics.Load(); metrics != nil {
		metrics.BrokerEvents.WithLabelValues(result).Inc()
	}
}

func (p *Publisher) observeQueueWait(request *publishRequest, outcome monitoring.PublishStageOutcome) {
	if metrics := p.metrics.Load(); metrics != nil {
		metrics.ObservePublishQueueWait(time.Since(request.queuedAt), outcome)
	}
}
