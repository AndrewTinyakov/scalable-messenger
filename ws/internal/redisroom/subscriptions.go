package redisroom

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

var errSubscriptionClosed = errors.New("Redis room subscription closed")

const roomEventBufferLimit = 256

// One PubSub connection handles all locally active channels on each Redis primary.
// Redis Cluster requires a channel's SSUBSCRIBE to run on its slot owner.
type subscriptionHub struct {
	owner  *Client
	mu     sync.Mutex
	groups map[string]*subscriptionGroup
	slots  []slotOwner
	closed bool
	wg     sync.WaitGroup
}

type subscriptionGroup struct {
	hub           *subscriptionHub
	address       string
	client        *redis.Client
	owned         bool
	pubsub        *redis.PubSub
	ctx           context.Context
	cancel        context.CancelFunc
	dropped       chan struct{} // closed after this group leaves the hub
	mu            sync.Mutex
	listeners     map[string]*Listener
	unsubscribing map[string]chan struct{} // per-channel unsubscribe completion, guarded by mu
	unsubscribe   func(context.Context, string) error
	started       bool
	closed        bool
}

type Listener struct {
	group       *subscriptionGroup
	room        string
	inline      [1]Live // ordinary single-event delivery needs no allocation
	pending     []Live  // ring buffer, grows only under a burst; guarded by group.mu
	head        int
	queued      int
	wake        chan struct{}
	ready       chan struct{}
	done        chan struct{}
	readyClosed bool  // guarded by group.mu
	readyErr    error // guarded by group.mu until ready closes
	terminalErr error // guarded by group.mu until done closes
}

func newListener(group *subscriptionGroup, room string) *Listener {
	listener := &Listener{
		group: group, room: room,
		wake: make(chan struct{}, 1), ready: make(chan struct{}), done: make(chan struct{}),
	}
	listener.pending = listener.inline[:]
	return listener
}

func newSubscriptionHub(owner *Client) *subscriptionHub {
	return &subscriptionHub{owner: owner, groups: make(map[string]*subscriptionGroup)}
}

func (h *subscriptionHub) Subscribe(ctx context.Context, room string) (*Listener, error) {
	for attempt := 0; attempt < 2; attempt++ {
		group, err := h.group(ctx, room)
		if err != nil {
			return nil, err
		}
		listener, err := group.add(ctx, room)
		if errors.Is(err, errSubscriptionClosed) {
			select {
			case <-group.dropped:
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			continue
		}
		return listener, err
	}
	return nil, errSubscriptionClosed
}

func (h *subscriptionHub) group(ctx context.Context, room string) (*subscriptionGroup, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closed {
		return nil, errSubscriptionClosed
	}
	address, err := h.address(ctx, room)
	if err != nil {
		return nil, err
	}
	if group := h.groups[address]; group != nil {
		return group, nil
	}
	client, standalone := h.owner.redis.(*redis.Client)
	if !standalone {
		client = redis.NewClient(&redis.Options{Addr: address})
	}
	groupCtx, cancel := context.WithCancel(context.Background())
	pubsub := client.SSubscribe(ctx)
	group := &subscriptionGroup{
		hub: h, address: address, client: client, owned: !standalone,
		pubsub: pubsub, ctx: groupCtx, cancel: cancel, dropped: make(chan struct{}),
		listeners:     make(map[string]*Listener),
		unsubscribing: make(map[string]chan struct{}),
		unsubscribe: func(ctx context.Context, channel string) error {
			return pubsub.SUnsubscribe(ctx, channel)
		},
	}
	h.groups[address] = group
	return group, nil
}

func (group *subscriptionGroup) add(ctx context.Context, room string) (*Listener, error) {
	channel := Channel(room)
	for {
		group.mu.Lock()
		if group.closed {
			group.mu.Unlock()
			return nil, errSubscriptionClosed
		}
		if pending := group.unsubscribing[channel]; pending != nil {
			group.mu.Unlock()
			select {
			case <-pending:
				continue
			case <-group.ctx.Done():
				return nil, errSubscriptionClosed
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		if group.listeners[channel] != nil {
			group.mu.Unlock()
			return nil, fmt.Errorf("room %s already has a Redis listener", room)
		}
		break
	}
	listener := newListener(group, room)
	group.listeners[channel] = listener
	err := group.pubsub.SSubscribe(ctx, channel)
	if err != nil {
		group.mu.Unlock()
		group.fail(fmt.Errorf("subscribe room %s: %w", room, err))
		return nil, err
	}
	if !group.started {
		group.hub.mu.Lock()
		if group.hub.closed {
			group.hub.mu.Unlock()
			group.mu.Unlock()
			return nil, errSubscriptionClosed
		}
		group.started = true
		group.hub.wg.Add(1)
		group.hub.mu.Unlock()
		go group.read()
	}
	group.mu.Unlock()
	select {
	case <-listener.ready:
		if listener.readyErr != nil {
			return nil, listener.readyErr
		}
		return listener, nil
	case <-ctx.Done():
		_ = listener.Close()
		return nil, ctx.Err()
	}
}

func (group *subscriptionGroup) read() {
	defer group.hub.wg.Done()
	for {
		value, err := group.pubsub.Receive(group.ctx)
		if err != nil {
			group.fail(fmt.Errorf("Redis room feed: %w", err))
			return
		}
		switch item := value.(type) {
		case *redis.Subscription:
			if item.Kind == "ssubscribe" {
				group.mu.Lock()
				if listener := group.listeners[item.Channel]; listener != nil {
					listener.signalReady(nil)
				}
				group.mu.Unlock()
			}
		case *redis.Message:
			group.deliver(item)
		}
	}
}

func (group *subscriptionGroup) deliver(message *redis.Message) {
	group.mu.Lock()
	listener := group.listeners[message.Channel]
	group.mu.Unlock()
	if listener == nil {
		return
	}
	live, err := decodeLive(listener.room, message.Payload)
	if err != nil {
		group.remove(listener, err)
		return
	}
	group.mu.Lock()
	if group.listeners[message.Channel] == listener {
		if !listener.enqueue(live) {
			group.mu.Unlock()
			group.remove(listener, errors.New("Redis room event buffer full"))
			return
		}
	}
	group.mu.Unlock()
}

// enqueue is called with group.mu held. A quiet room uses only its inline slot.
func (listener *Listener) enqueue(live Live) bool {
	if listener.queued == roomEventBufferLimit {
		return false
	}
	if listener.queued == len(listener.pending) {
		size := min(len(listener.pending)*2, roomEventBufferLimit)
		grown := make([]Live, size)
		for i := range listener.queued {
			grown[i] = listener.pending[(listener.head+i)%len(listener.pending)]
		}
		listener.pending = grown
		listener.head = 0
	}
	listener.pending[(listener.head+listener.queued)%len(listener.pending)] = live
	listener.queued++
	if listener.queued == 1 {
		select {
		case listener.wake <- struct{}{}:
		default:
		}
	}
	return true
}

func (listener *Listener) Receive(ctx context.Context) (Live, error) {
	for {
		listener.group.mu.Lock()
		if listener.terminalErr != nil {
			err := listener.terminalErr
			listener.group.mu.Unlock()
			return Live{}, err
		}
		if listener.queued > 0 {
			live := listener.pending[listener.head]
			listener.pending[listener.head] = Live{}
			listener.head = (listener.head + 1) % len(listener.pending)
			listener.queued--
			if listener.queued == 0 {
				listener.pending = listener.inline[:]
				listener.head = 0
			}
			listener.group.mu.Unlock()
			return live, nil
		}
		listener.group.mu.Unlock()
		select {
		case <-listener.done:
			return Live{}, listener.error()
		case <-listener.wake:
		case <-ctx.Done():
			return Live{}, ctx.Err()
		}
	}
}

func (listener *Listener) error() error {
	listener.group.mu.Lock()
	defer listener.group.mu.Unlock()
	return listener.terminalErr
}

func (listener *Listener) Close() error {
	listener.group.remove(listener, errSubscriptionClosed)
	return nil
}

func (listener *Listener) signalReady(err error) {
	if !listener.readyClosed {
		listener.readyErr = err
		listener.readyClosed = true
		close(listener.ready)
	}
}

func (listener *Listener) stop(err error) {
	listener.signalReady(err)
	listener.terminalErr = err
	listener.inline[0] = Live{}
	listener.pending = nil
	listener.head = 0
	listener.queued = 0
	close(listener.done)
}

func (group *subscriptionGroup) remove(listener *Listener, reason error) {
	channel := Channel(listener.room)
	group.mu.Lock()
	if group.listeners[channel] != listener {
		group.mu.Unlock()
		return
	}
	delete(group.listeners, channel)
	listener.stop(reason)
	last := len(group.listeners) == 0
	if last {
		group.closed = true
	} else {
		group.unsubscribing[channel] = make(chan struct{})
	}
	group.mu.Unlock()
	if last {
		group.close()
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	err := group.unsubscribe(ctx, channel)
	cancel()
	if err != nil {
		// The unsubscribe outcome is unknown. Rebuild the shared PubSub feed
		// before a new listener can trust this channel again.
		group.fail(fmt.Errorf("unsubscribe room %s: %w", listener.room, err))
	}
	group.mu.Lock()
	close(group.unsubscribing[channel])
	delete(group.unsubscribing, channel)
	group.mu.Unlock()
}

func (group *subscriptionGroup) fail(err error) {
	group.mu.Lock()
	if group.closed {
		group.mu.Unlock()
		return
	}
	group.closed = true
	for _, listener := range group.listeners {
		listener.stop(err)
	}
	clear(group.listeners)
	group.mu.Unlock()
	group.close()
}

func (group *subscriptionGroup) close() {
	group.cancel()
	_ = group.pubsub.Close()
	if group.owned {
		_ = group.client.Close()
	}
	group.hub.drop(group)
	close(group.dropped)
}

func (h *subscriptionHub) drop(group *subscriptionGroup) {
	h.mu.Lock()
	if h.groups[group.address] == group {
		delete(h.groups, group.address)
		h.slots = nil // A reconnect may have moved Redis Cluster slots.
	}
	h.mu.Unlock()
}

func (h *subscriptionHub) Close() {
	h.mu.Lock()
	h.closed = true
	groups := make([]*subscriptionGroup, 0, len(h.groups))
	for _, group := range h.groups {
		groups = append(groups, group)
	}
	h.mu.Unlock()
	for _, group := range groups {
		group.fail(errSubscriptionClosed)
	}
	h.wg.Wait()
}
