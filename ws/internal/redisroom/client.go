package redisroom

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/redis/go-redis/v9"
	"messenger/ws/internal/protocol"
)

type Client struct{ redis *redis.Client }
type Live struct {
	Epoch    string         `json:"epoch"`
	StreamID string         `json:"streamId"`
	Event    protocol.Event `json:"event"`
}

func New(rawURL string) (*Client, error) {
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("Redis URL: %w", err)
	}
	return &Client{redis: redis.NewClient(opts)}, nil
}

func (c *Client) Ping(ctx context.Context) error { return c.redis.Ping(ctx).Err() }
func (c *Client) Close() error                   { return c.redis.Close() }

// AllowSend applies a shared per-user limit across all WS nodes.
func (c *Client) AllowSend(ctx context.Context, userID string) (bool, error) {
	const script = `local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],1) end; return n`
	key := "messenger:rate:{" + userID + "}:send"
	n, err := c.redis.Eval(ctx, script, []string{key}).Int64()
	if err != nil {
		return false, err
	}
	return n <= 20, nil
}

func StreamKey(room string) string { return "messenger:{" + room + "}:stream" }
func EpochKey(room string) string  { return "messenger:{" + room + "}:epoch" }
func Channel(room string) string   { return "messenger:{" + room + "}:live" }

type Listener struct {
	subscription *redis.PubSub
	room         string
}

func (c *Client) Subscribe(ctx context.Context, room string) (*Listener, error) {
	if !validRoom(room) {
		return nil, errors.New("invalid room")
	}
	s := c.redis.SSubscribe(ctx, Channel(room))
	if _, err := s.Receive(ctx); err != nil {
		s.Close()
		return nil, fmt.Errorf("subscribe room: %w", err)
	}
	return &Listener{subscription: s, room: room}, nil
}

func (l *Listener) Receive(ctx context.Context) (Live, error) {
	msg, err := l.subscription.ReceiveMessage(ctx)
	if err != nil {
		return Live{}, err
	}
	var envelope struct {
		Epoch    string          `json:"epoch"`
		StreamID string          `json:"streamId"`
		Event    json.RawMessage `json:"event"`
	}
	d := json.NewDecoder(bytes.NewReader([]byte(msg.Payload)))
	d.DisallowUnknownFields()
	if err := d.Decode(&envelope); err != nil {
		return Live{}, fmt.Errorf("decode live envelope: %w", err)
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return Live{}, errors.New("multiple live envelopes")
	}
	if envelope.Epoch == "" || envelope.StreamID == "" || len(envelope.Event) == 0 {
		return Live{}, errors.New("incomplete live event")
	}
	event, err := protocol.DecodeEvent(envelope.Event)
	if err != nil {
		return Live{}, err
	}
	if event.Room != l.room {
		return Live{}, errors.New("event room mismatch")
	}
	live := Live{Epoch: envelope.Epoch, StreamID: envelope.StreamID, Event: event}
	live.Event.Room = l.room
	live.Event.Epoch = live.Epoch
	live.Event.StreamID = live.StreamID
	return live, nil
}
func (l *Listener) Close() error { return l.subscription.Close() }

func (c *Client) Tail(ctx context.Context, room string) (string, string, error) {
	epoch, err := c.redis.Get(ctx, EpochKey(room)).Result()
	if errors.Is(err, redis.Nil) {
		return "", "", nil
	}
	if err != nil {
		return "", "", err
	}
	entries, err := c.redis.XRevRangeN(ctx, StreamKey(room), "+", "-", 1).Result()
	if err != nil {
		return "", "", err
	}
	if len(entries) == 0 {
		return epoch, "", nil
	}
	return epoch, entries[0].ID, nil
}

func (c *Client) Replay(ctx context.Context, room, epoch, after string, limit int64) ([]Live, error) {
	current, _, err := c.Tail(ctx, room)
	if err != nil {
		return nil, err
	}
	if epoch == "" || after == "" || current != epoch {
		return nil, ErrGap
	}
	previous, err := c.redis.XRangeN(ctx, StreamKey(room), after, after, 1).Result()
	if err != nil {
		return nil, err
	}
	if len(previous) != 1 || previous[0].ID != after {
		return nil, ErrGap
	}
	entries, err := c.redis.XRangeN(ctx, StreamKey(room), "("+after, "+", limit+1).Result()
	if err != nil {
		return nil, err
	}
	if int64(len(entries)) > limit {
		return nil, ErrGap
	}
	result := make([]Live, 0, len(entries))
	for _, entry := range entries {
		payload, ok := entry.Values["event"].(string)
		if !ok {
			return nil, errors.New("history event missing")
		}
		event, err := protocol.DecodeEvent([]byte(payload))
		if err != nil {
			return nil, fmt.Errorf("decode history event: %w", err)
		}
		if event.Room != room {
			return nil, errors.New("history event room mismatch")
		}
		event.Room = room
		event.Epoch = epoch
		event.StreamID = entry.ID
		result = append(result, Live{Epoch: epoch, StreamID: entry.ID, Event: event})
	}
	return result, nil
}

var ErrGap = errors.New("Redis history incomplete")

func validRoom(room string) bool {
	if strings.ContainsAny(room, "{} \n\r\t") {
		return false
	}
	return strings.HasPrefix(room, "user:") || strings.HasPrefix(room, "group:")
}
