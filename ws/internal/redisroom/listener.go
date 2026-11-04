package redisroom

import "context"

const roomEventBufferLimit = 256

const roomEventBufferByteLimit = 1 << 20

type Listener struct {
	group       *subscriptionGroup
	room        string
	inline      [1]Live // ordinary single-event delivery needs no allocation
	pending     []Live  // ring buffer, grows only under a burst; guarded by group.mu
	head        int
	queued      int
	queuedBytes int
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

// enqueue is called with group.mu held. A quiet room uses only its inline slot.
func (listener *Listener) enqueue(live Live, size int) bool {
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
		if listener.terminalErr != nil {
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
	listener.queuedBytes = 0
	close(listener.done)
}
