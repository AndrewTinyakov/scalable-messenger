package socket

import (
	"context"
	"errors"
	"sync"
	"time"

	"messenger/ws/internal/monitoring"
	"messenger/ws/internal/protocol"
)

var errCommandCapacity = errors.New("command capacity reached")

type queuedCommand struct {
	frame    protocol.Frame
	bytes    int
	deadline time.Time
	admitted time.Time
}

type commandQueue struct {
	server   *Server
	mu       sync.Mutex
	items    int
	bytes    int
	maxItems int
	maxBytes int
	ready    chan *Connection
}

func (queue *commandQueue) reserve(bytes int) bool {
	queue.mu.Lock()
	defer queue.mu.Unlock()
	if queue.items >= queue.maxItems || bytes > queue.maxBytes-queue.bytes {
		return false
	}
	queue.items++
	queue.bytes += bytes
	queue.server.metrics.CommandItems.Inc()
	queue.server.metrics.CommandBytes.Add(float64(bytes))
	return true
}

func (queue *commandQueue) release(bytes int) {
	queue.mu.Lock()
	queue.items--
	queue.bytes -= bytes
	queue.server.metrics.CommandItems.Dec()
	queue.server.metrics.CommandBytes.Sub(float64(bytes))
	queue.mu.Unlock()
}

func (c *Connection) enqueueCommand(frame protocol.Frame, bytes int) error {
	timeout := c.server.config.APITimeout
	if frame.Type == protocol.FrameSend {
		timeout = c.server.config.ConfirmTimeout
	}
	if timeout <= 0 {
		timeout = 3 * time.Second
	}
	command := queuedCommand{frame: frame, bytes: bytes, deadline: time.Now().Add(timeout), admitted: time.Now()}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.closed {
		return context.Canceled
	}
	itemLimit := c.server.config.ConnectionCommandItems
	if itemLimit <= 0 {
		itemLimit = 32
	}
	byteLimit := c.server.config.ConnectionCommandBytes
	if byteLimit <= 0 {
		byteLimit = 131072
	}
	items := len(c.commands)
	if c.commandRunning {
		items++
	}
	if items >= itemLimit || bytes > byteLimit-c.commandBytes || !c.server.commands.reserve(bytes) {
		return errCommandCapacity
	}
	c.commands = append(c.commands, command)
	c.commandBytes += bytes
	if !c.commandScheduled {
		c.commandScheduled = true
		c.server.commands.ready <- c
	}
	return nil
}

func (queue *commandQueue) run() {
	for {
		select {
		case <-queue.server.ctx.Done():
			return
		case connection := <-queue.ready:
			connection.mu.Lock()
			if connection.closed || len(connection.commands) == 0 {
				connection.commandScheduled = false
				connection.mu.Unlock()
				continue
			}
			command := connection.commands[0]
			connection.commands[0] = queuedCommand{}
			connection.commands = connection.commands[1:]
			connection.commandRunning = true
			connection.mu.Unlock()
			started := time.Now()
			kind := monitoring.CommandKind(command.frame.Type)
			queue.server.metrics.CommandWait.WithLabelValues(kind).Observe(started.Sub(command.admitted).Seconds())
			queue.server.metrics.CommandWorkers.Inc()
			ctx, cancel := context.WithDeadline(connection.ctx, command.deadline)
			err := ctx.Err()
			if err == nil {
				err = connection.handleContext(ctx, command.frame)
			}
			queue.server.metrics.CommandWorkers.Dec()
			result := "success"
			if err != nil {
				result = "failed"
			}
			queue.server.metrics.CommandService.WithLabelValues(kind, result).Observe(time.Since(started).Seconds())
			cancel()
			if err != nil && connection.ctx.Err() == nil {
				connection.handleError(err, command.frame.RequestID)
			}
			connection.mu.Lock()
			connection.commandRunning = false
			connection.commandBytes -= command.bytes
			queue.release(command.bytes)
			if !connection.closed && len(connection.commands) > 0 {
				queue.ready <- connection
			} else {
				connection.commandScheduled = false
			}
			connection.mu.Unlock()
		}
	}
}

func (c *Connection) clearCommandsLocked() {
	for _, command := range c.commands {
		c.server.commands.release(command.bytes)
		c.commandBytes -= command.bytes
	}
	c.commands = nil
}
