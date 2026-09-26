package room

import (
	"context"
	"time"
)

func (r *Rooms) listen(ctx context.Context, entry *localRoom) {
	defer r.wg.Done()
	listener, err := r.redis.Subscribe(ctx, entry.name)
	var epoch, last string
	if err == nil {
		epoch, last, err = r.redis.Tail(ctx, entry.name)
	}
	r.mu.Lock()
	entry.err = err
	entry.epoch, entry.lastID = epoch, last
	close(entry.ready)
	r.mu.Unlock()
	if err != nil {
		if listener != nil {
			listener.Close()
		}
		r.logger.Error("subscribe room", "room", entry.name, "error", err)
		return
	}
	defer func() {
		if listener != nil {
			_ = listener.Close()
		}
	}()
	for {
		live, err := listener.Receive(ctx)
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			r.logger.Error("Redis room feed stopped", "room", entry.name, "error", err)
			r.failRoom(entry.name)
			_ = listener.Close()
			for {
				if ctx.Err() != nil {
					return
				}
				timer := time.NewTimer(time.Second)
				select {
				case <-timer.C:
				case <-ctx.Done():
					timer.Stop()
					return
				}
				next, subscribeErr := r.redis.Subscribe(ctx, entry.name)
				if subscribeErr != nil {
					continue
				}
				epoch, last, tailErr := r.redis.Tail(ctx, entry.name)
				if tailErr != nil {
					_ = next.Close()
					continue
				}
				listener = next
				r.setPosition(entry.name, epoch, last)
				break
			}
			continue
		}
		r.dispatch(entry.name, live.Event)
	}
}
