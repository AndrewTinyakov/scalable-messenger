package presence

import (
	"context"
	"time"

	"messenger/ws/internal/grpcauth"
	"messenger/ws/internal/protocol"
	"messenger/ws/internal/redisroom"
)

type Store interface {
	SetPresence(context.Context, string, map[string]bool) map[string]error
	PresenceSnapshot(context.Context, []string) (map[string]redisroom.PresenceState, map[int]int64, error)
	SubscribePresence(context.Context, int) (Feed, error)
	PresenceGatewayUsers(context.Context, string, uint64) ([]string, uint64, error)
	ForgetPresenceGateway(context.Context, string) error
}

type Feed interface {
	Receive(context.Context) (redisroom.Live, error)
	Close() error
}

type Authorizer interface {
	PresenceVisibility(context.Context, string, []string) (map[string]grpcauth.Visibility, error)
	OnlineCountMembers(context.Context, string, string, int) (int, []string, error)
}

type LastSeenRecorder interface {
	RecordLastSeen(context.Context, []grpcauth.LastSeen) error
}

// Watcher is one socket that observes presence.
type Watcher interface {
	Enqueue(protocol.Event) bool
	PresenceSession() string
	Closed() bool
}

type Config struct {
	Grace          time.Duration
	Timeout        time.Duration
	GrantTTL       time.Duration
	Linger         time.Duration
	FlushInterval  time.Duration
	HotWatchers    int
	HotInterval    time.Duration
	MaxWatched     int
	MaxCountGroup  int
	LastSeenFlush  time.Duration
	LastSeenMinGap time.Duration
	LastSeenActive time.Duration
}

func DefaultConfig() Config {
	return Config{
		Grace: 2 * time.Second, Timeout: 3 * time.Second, GrantTTL: 15 * time.Minute, Linger: 30 * time.Second,
		FlushInterval: 200 * time.Millisecond, HotWatchers: 500, HotInterval: 3 * time.Second,
		MaxWatched: 500, MaxCountGroup: 200,
		LastSeenFlush: 5 * time.Second, LastSeenMinGap: time.Minute, LastSeenActive: 10 * time.Minute,
	}
}

type redisStore struct{ *redisroom.Client }

// RedisStore adapts the Redis client to the presence store.
func RedisStore(client *redisroom.Client) Store { return redisStore{client} }

func (s redisStore) SubscribePresence(ctx context.Context, bucket int) (Feed, error) {
	feed, err := s.Client.SubscribePresence(ctx, bucket)
	if err != nil {
		// A nil *Listener in the interface would not compare equal to nil.
		return nil, err
	}
	return feed, nil
}
