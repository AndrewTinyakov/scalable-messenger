package redisroom

import (
	"context"
	"errors"
	"sync"

	"github.com/redis/go-redis/v9"
)

var (
	errSubscriptionClosed = errors.New("Redis room subscription closed")
	errSubscriptionMoved  = errors.New("Redis room subscription moved")
)

type subscriptionHubState uint8

const (
	subscriptionHubOpen subscriptionHubState = iota
	subscriptionHubClosed
)

type subscriptionHub struct {
	owner  *Client
	mu     sync.Mutex
	groups map[string]*subscriptionGroup
	slots  []slotOwner
	state  subscriptionHubState
	wg     sync.WaitGroup
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
			case <-group.removedFromHub:
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
	if h.state == subscriptionHubClosed {
		return nil, errSubscriptionClosed
	}
	address, err := h.slotOwnerAddressLocked(ctx, room)
	if err != nil {
		return nil, err
	}
	if group := h.groups[address]; group != nil {
		return group, nil
	}
	client, standalone := h.owner.redis.(*redis.Client)
	if !standalone {
		client = redis.NewClient(nodeOptions(h.owner.connectionOptions, address))
	}
	groupCtx, cancel := context.WithCancel(context.Background())
	pubsub := client.SSubscribe(ctx)
	group := &subscriptionGroup{
		hub: h, address: address, client: client, owned: !standalone,
		pubsub: pubsub, ctx: groupCtx, cancel: cancel, removedFromHub: make(chan struct{}),
		listeners:               make(map[string]*Listener),
		pendingUnsubscribes:     make(map[string]chan struct{}),
		expectedUnsubscribeAcks: make(map[string]int),
		unsubscribe: func(ctx context.Context, channel string) error {
			return pubsub.SUnsubscribe(ctx, channel)
		},
	}
	h.groups[address] = group
	return group, nil
}

func (h *subscriptionHub) Close() {
	h.mu.Lock()
	h.state = subscriptionHubClosed
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

func (h *subscriptionHub) invalidateSlotOwners() {
	h.mu.Lock()
	h.slots = nil
	h.mu.Unlock()
}
