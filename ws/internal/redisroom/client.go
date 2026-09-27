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

type Client struct {
	redis redis.UniversalClient
	seeds []*redis.Client
	subs  *subscriptionHub
}
type Live struct {
	Epoch            string         `json:"epoch"`
	StreamID         string         `json:"streamId"`
	PreviousStreamID string         `json:"previousStreamId,omitempty"`
	HasPrevious      bool           `json:"-"`
	Event            protocol.Event `json:"event"`
}

func New(rawURL string, clusterNodes []string) (*Client, error) {
	if len(clusterNodes) > 0 {
		seeds := make([]*redis.Client, 0, len(clusterNodes))
		for _, address := range clusterNodes {
			seeds = append(seeds, redis.NewClient(&redis.Options{Addr: address}))
		}
		cluster := redis.NewClusterClient(&redis.ClusterOptions{
			Addrs: clusterNodes,
			ClusterSlots: func(ctx context.Context) ([]redis.ClusterSlot, error) {
				var lastErr error
				for _, seed := range seeds {
					slots, err := seed.ClusterSlots(ctx).Result()
					if err == nil && validClusterSlots(slots) {
						return slots, nil
					}
					if err != nil {
						lastErr = err
					} else {
						lastErr = errors.New("incomplete Redis Cluster topology")
					}
				}
				return nil, fmt.Errorf("Redis Cluster topology unavailable: %w", lastErr)
			},
		})
		client := &Client{redis: cluster, seeds: seeds}
		client.subs = newSubscriptionHub(client)
		return client, nil
	}
	opts, err := redis.ParseURL(rawURL)
	if err != nil {
		return nil, fmt.Errorf("Redis URL: %w", err)
	}
	client := &Client{redis: redis.NewClient(opts)}
	client.subs = newSubscriptionHub(client)
	return client, nil
}

func (c *Client) Ping(ctx context.Context) error { return c.redis.Ping(ctx).Err() }
func (c *Client) Close() error {
	c.subs.Close()
	err := c.redis.Close()
	for _, seed := range c.seeds {
		err = errors.Join(err, seed.Close())
	}
	return err
}

func validClusterSlots(slots []redis.ClusterSlot) bool {
	if len(slots) == 0 {
		return false
	}
	for _, slot := range slots {
		if len(slot.Nodes) == 0 || slot.Nodes[0].Addr == "" || strings.HasSuffix(slot.Nodes[0].Addr, ":0") {
			return false
		}
	}
	return true
}

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

func (c *Client) Subscribe(ctx context.Context, room string) (*Listener, error) {
	if !validRoom(room) {
		return nil, errors.New("invalid room")
	}
	return c.subs.Subscribe(ctx, room)
}

func decodeLive(room, payload string) (Live, error) {
	var envelope struct {
		Epoch            string          `json:"epoch"`
		StreamID         string          `json:"streamId"`
		PreviousStreamID *string         `json:"previousStreamId"`
		Event            json.RawMessage `json:"event"`
	}
	d := json.NewDecoder(bytes.NewReader([]byte(payload)))
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
	if event.Room != room {
		return Live{}, errors.New("event room mismatch")
	}
	live := Live{Epoch: envelope.Epoch, StreamID: envelope.StreamID, Event: event}
	if envelope.PreviousStreamID != nil {
		live.PreviousStreamID = *envelope.PreviousStreamID
		live.HasPrevious = true
	}
	live.Event.Room = room
	live.Event.Epoch = live.Epoch
	live.Event.StreamID = live.StreamID
	return live, nil
}

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
