package redisroom

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"strings"

	"github.com/redis/go-redis/v9"

	"messenger/ws/internal/roomname"
)

var setPresenceScript = redis.NewScript(`
local function online()
  for _,field in ipairs(redis.call('HKEYS',KEYS[1])) do
    if string.sub(field,1,2)=='g:' then return true end
  end
  return false
end
local before=online()
if ARGV[2]=='1' then redis.call('HSET',KEYS[1],ARGV[1],1) else redis.call('HDEL',KEYS[1],ARGV[1]) end
local after=online()
if before==after then return 0 end
local t=redis.call('TIME')
local now=t[1]*1000000+t[2]
local version=math.max((tonumber(redis.call('HGET',KEYS[1],'v')) or 0)+1,now)
redis.call('HSET',KEYS[1],'v',string.format('%.0f',version))
local seen=tonumber(redis.call('HGET',KEYS[1],'ls')) or 0
if after then
  redis.call('PERSIST',KEYS[1])
else
  seen=math.floor(now/1000)
  redis.call('HSET',KEYS[1],'ls',seen)
  redis.call('PEXPIRE',KEYS[1],ARGV[5])
end
local seq=redis.call('INCR',KEYS[2])
redis.call('SPUBLISH',ARGV[4],cjson.encode({u=ARGV[3],v=string.format('%.0f',version),s=seq,o=after,l=seen}))
return 1`)

const presenceStateTTLMillis = 30 * 24 * 60 * 60 * 1000

type PresenceState struct {
	Online   bool
	Version  int64
	LastSeen int64
}

func presenceStateKey(bucket int, userID string) string {
	return "messenger:{" + roomname.PresenceBucket(bucket) + "}:u:" + userID
}

func presenceSeqKey(bucket int) string {
	return "messenger:{" + roomname.PresenceBucket(bucket) + "}:seq"
}

func presenceGatewayKey(gateway string) string {
	return "messenger:presence:gateway:{" + gateway + "}:users"
}

func (c *Client) SetPresence(ctx context.Context, gateway string, active map[string]bool) map[string]error {
	index := presenceGatewayKey(gateway)
	failed := make(map[string]error)
	var online []any
	for userID, on := range active {
		if on {
			online = append(online, userID)
		}
	}
	if len(online) > 0 {
		if err := c.redis.SAdd(ctx, index, online...).Err(); err != nil {
			for _, userID := range online {
				failed[userID.(string)] = err
			}
		}
	}
	pipe := c.redis.Pipeline()
	commands := make(map[string]*redis.Cmd, len(active))
	for userID, on := range active {
		if failed[userID] != nil {
			continue
		}
		b := roomname.PresenceBucketOf(userID)
		value := "0"
		if on {
			value = "1"
		}
		commands[userID] = setPresenceScript.Eval(ctx, pipe, []string{presenceStateKey(b, userID), presenceSeqKey(b)}, "g:"+gateway, value, userID, Channel(roomname.PresenceBucket(b)), presenceStateTTLMillis)
	}
	_, _ = pipe.Exec(ctx)
	var cleared []any
	for userID, command := range commands {
		if err := command.Err(); err != nil && !errors.Is(err, redis.Nil) {
			failed[userID] = err
		} else if !active[userID] {
			cleared = append(cleared, userID)
		}
	}
	if len(cleared) > 0 {
		if err := c.redis.SRem(ctx, index, cleared...).Err(); err != nil {
			for _, userID := range cleared {
				failed[userID.(string)] = err
			}
		}
	}
	return failed
}

func (c *Client) PresenceGatewayUsers(ctx context.Context, gateway string, cursor uint64) ([]string, uint64, error) {
	return c.redis.SScan(ctx, presenceGatewayKey(gateway), cursor, "", 500).Result()
}

func (c *Client) ForgetPresenceGateway(ctx context.Context, gateway string) error {
	return c.redis.Del(ctx, presenceGatewayKey(gateway)).Err()
}

func (c *Client) PresenceSnapshot(ctx context.Context, userIDs []string) (map[string]PresenceState, map[int]int64, error) {
	pipe := c.redis.Pipeline()
	states := make(map[string]*redis.MapStringStringCmd, len(userIDs))
	seqs := make(map[int]*redis.StringCmd)
	for _, userID := range userIDs {
		b := roomname.PresenceBucketOf(userID)
		states[userID] = pipe.HGetAll(ctx, presenceStateKey(b, userID))
		if seqs[b] == nil {
			seqs[b] = pipe.Get(ctx, presenceSeqKey(b))
		}
	}
	if _, err := pipe.Exec(ctx); err != nil && !errors.Is(err, redis.Nil) {
		return nil, nil, fmt.Errorf("presence snapshot: %w", err)
	}
	result := make(map[string]PresenceState, len(states))
	for userID, command := range states {
		state, err := decodePresenceState(command.Val())
		if err != nil {
			return nil, nil, err
		}
		result[userID] = state
	}
	sequences := make(map[int]int64, len(seqs))
	for b, command := range seqs {
		value, err := command.Int64()
		if err != nil && !errors.Is(err, redis.Nil) {
			return nil, nil, fmt.Errorf("presence sequence: %w", err)
		}
		sequences[b] = value
	}
	return result, sequences, nil
}

func decodePresenceState(fields map[string]string) (PresenceState, error) {
	var state PresenceState
	var err error
	for field, value := range fields {
		switch {
		case strings.HasPrefix(field, "g:"):
			state.Online = true
		case field == "v":
			state.Version, err = strconv.ParseInt(value, 10, 64)
		case field == "ls":
			state.LastSeen, err = strconv.ParseInt(value, 10, 64)
		}
		if err != nil {
			return PresenceState{}, fmt.Errorf("decode presence state: %w", err)
		}
	}
	return state, nil
}

func (c *Client) SubscribePresence(ctx context.Context, bucket int) (*Listener, error) {
	return c.Subscribe(ctx, roomname.PresenceBucket(bucket))
}
