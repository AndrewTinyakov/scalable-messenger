package redisroom

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

const maxLiveEventBytes = 64 << 10

type subscriptionGroupState uint8

const (
	subscriptionIdle subscriptionGroupState = iota
	subscriptionReading
	subscriptionClosed
)

type subscriptionGroup struct {
	hub                     *subscriptionHub
	address                 string
	client                  *redis.Client
	owned                   bool
	pubsub                  *redis.PubSub
	ctx                     context.Context
	cancel                  context.CancelFunc
	removedFromHub          chan struct{}
	mu                      sync.Mutex
	listeners               map[string]*Listener
	pendingUnsubscribes     map[string]chan struct{}
	expectedUnsubscribeAcks map[string]int
	unsubscribe             func(context.Context, string) error
	state                   subscriptionGroupState
}

func (group *subscriptionGroup) add(ctx context.Context, room string) (*Listener, error) {
	channel := Channel(room)
	for {
		group.mu.Lock()
		if group.state == subscriptionClosed {
			group.mu.Unlock()
			return nil, errSubscriptionClosed
		}
		if pending := group.pendingUnsubscribes[channel]; pending != nil {
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
	if group.state == subscriptionIdle {
		group.hub.mu.Lock()
		if group.hub.state == subscriptionHubClosed {
			group.hub.mu.Unlock()
			group.mu.Unlock()
			return nil, errSubscriptionClosed
		}
		group.state = subscriptionReading
		if group.hub.owner.metrics != nil {
			group.hub.owner.metrics.BrokerEvents.WithLabelValues("feed_started").Inc()
		}
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
			group.mu.Lock()
			listener := group.listeners[item.Channel]
			switch item.Kind {
			case "ssubscribe":
				if listener != nil {
					listener.signalReadyLocked(nil)
				}
			case "sunsubscribe":
				if group.expectedUnsubscribeAcks[item.Channel] > 0 {
					if group.expectedUnsubscribeAcks[item.Channel]--; group.expectedUnsubscribeAcks[item.Channel] == 0 {
						delete(group.expectedUnsubscribeAcks, item.Channel)
					}
				} else if listener != nil {
					group.hub.invalidateSlotOwners()
					go group.remove(listener, errSubscriptionMoved)
				}
			}
			group.mu.Unlock()
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
	if len(message.Payload) > maxLiveEventBytes {
		if group.hub.owner.metrics != nil {
			group.hub.owner.metrics.BrokerEvents.WithLabelValues("oversize").Inc()
		}
		group.remove(listener, errors.New("Redis room event too large"))
		return
	}
	live, err := decodeLive(listener.room, message.Payload)
	if err != nil {
		if group.hub.owner.metrics != nil {
			group.hub.owner.metrics.BrokerEvents.WithLabelValues("decode_failed").Inc()
		}
		group.remove(listener, err)
		return
	}
	group.mu.Lock()
	if group.listeners[message.Channel] == listener {
		if !listener.enqueueLocked(live, len(message.Payload)) {
			if group.hub.owner.metrics != nil {
				group.hub.owner.metrics.BrokerEvents.WithLabelValues("buffer_full").Inc()
			}
			group.mu.Unlock()
			group.remove(listener, errors.New("Redis room event buffer full"))
			return
		}
	}
	group.mu.Unlock()
}

func (group *subscriptionGroup) remove(listener *Listener, reason error) {
	channel := Channel(listener.room)
	group.mu.Lock()
	if group.listeners[channel] != listener {
		group.mu.Unlock()
		return
	}
	delete(group.listeners, channel)
	listener.stopLocked(reason)
	last := len(group.listeners) == 0
	if last {
		group.state = subscriptionClosed
	} else {
		group.pendingUnsubscribes[channel] = make(chan struct{})
		group.expectedUnsubscribeAcks[channel]++
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
		group.fail(fmt.Errorf("unsubscribe room %s: %w", listener.room, err))
	}
	group.mu.Lock()
	close(group.pendingUnsubscribes[channel])
	delete(group.pendingUnsubscribes, channel)
	group.mu.Unlock()
}

func (group *subscriptionGroup) fail(err error) {
	group.mu.Lock()
	if group.state == subscriptionClosed {
		group.mu.Unlock()
		return
	}
	group.state = subscriptionClosed
	if group.hub.owner.metrics != nil && group.ctx.Err() == nil {
		group.hub.owner.metrics.BrokerEvents.WithLabelValues("redis_feed_failed").Inc()
	}
	for _, listener := range group.listeners {
		listener.stopLocked(err)
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
	close(group.removedFromHub)
}

func (h *subscriptionHub) drop(group *subscriptionGroup) {
	h.mu.Lock()
	if h.groups[group.address] == group {
		delete(h.groups, group.address)
		h.slots = nil
	}
	h.mu.Unlock()
}
