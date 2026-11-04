package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
)

type event struct {
	Type      string `json:"type"`
	ChatID    string `json:"chatId"`
	RequestID string `json:"requestId"`
	EventID   string `json:"eventId"`
	SenderID  string `json:"senderId"`
	Sequence  string `json:"sequence"`
	Epoch     string `json:"epoch"`
	StreamID  string `json:"streamId"`
	Body      string `json:"body"`
	Code      string `json:"code"`
	CreatedAt string `json:"createdAt"`
}

type client struct {
	index      int
	owner      *run
	session    session
	slow       bool
	ready      chan struct{}
	readyOnce  sync.Once
	setupError chan error
	mu         sync.Mutex
	conn       *websocket.Conn
	chats      map[string]*chatProgress
	sequence   uint64
	epoch      string
	streamID   string
	delivered  atomic.Int64
	duplicates atomic.Int64
	connected  atomic.Bool
}

func (socket *client) loop(ctx context.Context) {
	first := true
	for ctx.Err() == nil {
		attempt, cancel := context.WithTimeout(ctx, 15*time.Second)
		var ticket struct {
			Token string `json:"token"`
		}
		err := socket.owner.api(attempt, socket.session.Cookie, http.MethodPost, "/auth/ws-ticket", nil, &ticket)
		var conn *websocket.Conn
		if err == nil {
			dialer := websocket.Dialer{Subprotocols: []string{"messenger", "messenger-ticket." + ticket.Token}, HandshakeTimeout: 5 * time.Second}
			conn, response, dialErr := dialer.DialContext(attempt, socket.owner.opts.wsURL, http.Header{"Origin": []string{socket.owner.opts.origin}})
			if response != nil && response.Body != nil {
				response.Body.Close()
			}
			if dialErr != nil {
				err = dialErr
			} else {
				socket.mu.Lock()
				socket.conn = conn
				socket.mu.Unlock()
			}
		}
		cancel()
		socket.mu.Lock()
		conn = socket.conn
		socket.mu.Unlock()
		if err == nil && conn != nil {
			socket.connected.Store(true)
			if socket.owner.mixed != nil {
				err = socket.subscribeMixed()
			} else if socket.owner.manifest.GroupID != "" {
				subscription := map[string]any{"type": "subscribe", "chatId": socket.owner.manifest.GroupID, "kind": "GROUP", "lastAppliedSequence": strconv.FormatUint(socket.sequence, 10)}
				if socket.epoch != "" && socket.streamID != "" {
					subscription["epoch"], subscription["streamId"] = socket.epoch, socket.streamID
				}
				err = socket.send(subscription)
			} else {
				socket.readyOnce.Do(func() { close(socket.ready) })
			}
			if !first {
				socket.owner.reconnect.Add(1)
			}
			first = false
			if err == nil {
				err = socket.read(ctx, conn)
			}
			socket.connected.Store(false)
			conn.Close()
			socket.mu.Lock()
			if socket.conn == conn {
				socket.conn = nil
			}
			socket.mu.Unlock()
			if ctx.Err() != nil {
				return
			}
			socket.owner.closes.Add(1)
		}
		if socket.owner.opts.mode != "reconnect" && socket.owner.opts.mode != "drain" {
			select {
			case socket.setupError <- err:
			default:
			}
			if !socket.slow {
				socket.owner.errors.Add(1)
			}
			return
		}
		if !wait(ctx, 500*time.Millisecond) {
			return
		}
	}
}

func (socket *client) read(ctx context.Context, conn *websocket.Conn) error {
	conn.SetReadLimit(64 << 10)
	for ctx.Err() == nil {
		var frame event
		if err := conn.ReadJSON(&frame); err != nil {
			return err
		}
		receivedAt := time.Now()
		switch frame.Type {
		case "subscribed":
			if socket.owner.mixed != nil {
				if err := socket.subscribedMixed(frame.ChatID); err != nil {
					return err
				}
				continue
			}
			socket.readyOnce.Do(func() { close(socket.ready) })
			if socket.slow {
				<-ctx.Done()
				return ctx.Err()
			}
		case "error":
			socket.owner.errors.Add(1)
			count, _ := socket.owner.errorCodes.LoadOrStore(frame.Code, &atomic.Int64{})
			count.(*atomic.Int64).Add(1)
			select {
			case socket.setupError <- fmt.Errorf("server rejected frame: %s", frame.Code):
			default:
			}
		case "queued":
			socket.owner.queued.Add(1)
			socket.owner.trace.record(traceRecord{Kind: "queued", Socket: socket.index, RequestID: frame.RequestID, ObservedAt: receivedAt})
		case "message_saved":
			if err := socket.savedAt(frame, receivedAt, "websocket"); err != nil {
				return err
			}

		case "recovery_failed":
			if socket.owner.mixed != nil {
				if err := socket.recoverMixed(ctx, frame.ChatID); err != nil {
					return err
				}
				continue
			}
			if frame.ChatID == socket.owner.manifest.GroupID {
				if err := socket.recover(ctx); err != nil {
					return err
				}
			}
		}
	}
	return ctx.Err()
}

func (socket *client) send(frame map[string]any) error {
	socket.mu.Lock()
	defer socket.mu.Unlock()
	return socket.writeLocked(frame)
}

func (socket *client) writeLocked(frame map[string]any) error {
	frame["version"] = 1
	if socket.conn == nil {
		return errors.New("socket is reconnecting")
	}
	if err := socket.conn.SetWriteDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	return socket.conn.WriteJSON(frame)
}

func (socket *client) interrupt() {
	socket.mu.Lock()
	conn := socket.conn
	socket.mu.Unlock()
	if conn != nil {
		conn.Close()
	}
}
