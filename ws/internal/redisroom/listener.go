package redisroom

import "context"

const roomEventBufferLimit = 256

const roomEventBufferByteLimit = 1 << 20

type listenerState uint8

const (
	listenerSubscribing listenerState = iota
	listenerReady
	listenerStopped
)

type Listener struct {
	group       *subscriptionGroup
	room        string
	inlineEvent [1]Live
	pending     []Live
	head        int
	queued      int
	queuedBytes int
	wake        chan struct{}
	ready       chan struct{}
	done        chan struct{}
	state       listenerState
	readyErr    error
	terminalErr error
}

func newListener(group *subscriptionGroup, room string) *Listener {
	listener := &Listener{
		group: group, room: room,
		wake: make(chan struct{}, 1), ready: make(chan struct{}), done: make(chan struct{}),
	}
	listener.pending = listener.inlineEvent[:]
	return listener
}

func (listener *Listener) enqueueLocked(live Live, size int) bool {
	if listener.queued == roomEventBufferLimit || listener.queuedBytes+size > roomEventBufferByteLimit {
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
	live.bufferBytes = size
	listener.pending[(listener.head+listener.queued)%len(listener.pending)] = live
	listener.queued++
	listener.queuedBytes += size
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
		if listener.state == listenerStopped {
			err := listener.terminalErr
			listener.group.mu.Unlock()
			return Live{}, err
		}
		if listener.queued > 0 {
			live := listener.pending[listener.head]
			listener.queuedBytes -= live.bufferBytes
			listener.pending[listener.head] = Live{}
			listener.head = (listener.head + 1) % len(listener.pending)
			listener.queued--
			if listener.queued == 0 {
				listener.pending = listener.inlineEvent[:]
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

func (listener *Listener) signalReadyLocked(err error) {
	if listener.state == listenerSubscribing {
		listener.readyErr = err
		listener.state = listenerReady
		close(listener.ready)
	}
}

func (listener *Listener) stopLocked(err error) {
	listener.signalReadyLocked(err)
	listener.terminalErr = err
	listener.state = listenerStopped
	listener.inlineEvent[0] = Live{}
	listener.pending = nil
	listener.head = 0
	listener.queued = 0
	listener.queuedBytes = 0
	close(listener.done)
}
