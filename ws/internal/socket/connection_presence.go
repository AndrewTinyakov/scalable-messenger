package socket

import (
	"context"

	"messenger/ws/internal/protocol"
)

type connectionPresence struct {
	started bool
	active  bool
}

func (c *Connection) PresenceSession() string { return c.session.SessionID }

func (c *Connection) Closed() bool { return c.ctx.Err() != nil }

func (c *Connection) startPresence() {
	c.mu.Lock()
	if c.state == lifecycleClosed {
		c.mu.Unlock()
		return
	}
	c.presence = connectionPresence{started: true, active: true}
	c.server.tracker.SetActive(c.session.UserID, true)
	c.mu.Unlock()
	cfg := c.server.config
	c.Enqueue(protocol.Event{Type: protocol.EventPresenceConfig, Version: 1, IdleAfterHiddenMS: int(cfg.IdleAfterHidden.Milliseconds()), IdleAfterInputMS: int(cfg.IdleAfterInput.Milliseconds()), ReleaseAfterHiddenMS: int(cfg.ReleaseAfterHidden.Milliseconds())})
}

func (c *Connection) stopPresence() {
	c.server.watchers.Remove(c)
	c.mu.Lock()
	if c.presence.active {
		c.server.tracker.SetActive(c.session.UserID, false)
	}
	c.presence = connectionPresence{}
	c.mu.Unlock()
}

func (c *Connection) setActivity(active, visible bool) {
	c.mu.Lock()
	if c.state == lifecycleClosed || !c.presence.started {
		c.mu.Unlock()
		return
	}
	if c.presence.active != active {
		c.presence.active = active
		c.server.tracker.SetActive(c.session.UserID, active)
	}
	c.mu.Unlock()
	c.server.watchers.SetVisible(c, visible)
}

func (c *Connection) allowWatch(ctx context.Context) error {
	allowed, err := c.server.watchLimiter.AllowPresenceWatch(ctx, c.session.UserID)
	if err != nil {
		return err
	}
	if !allowed {
		return errRateLimited
	}
	return nil
}

func (c *Connection) watchPresence(base context.Context, f protocol.Frame) error {
	ctx, cancel := context.WithTimeout(base, c.server.config.APITimeout)
	defer cancel()
	if len(f.Add) > 0 {
		if err := c.allowWatch(ctx); err != nil {
			return err
		}
	}
	return c.server.watchers.Watch(ctx, c, f.Add, f.Remove, f.Reset)
}

func (c *Connection) watchOnlineCount(base context.Context, chatID string) error {
	ctx, cancel := context.WithTimeout(base, c.server.config.APITimeout)
	defer cancel()
	if chatID != "" {
		if err := c.allowWatch(ctx); err != nil {
			return err
		}
	}
	return c.server.watchers.WatchOnlineCount(ctx, c, chatID)
}
