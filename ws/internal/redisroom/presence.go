package redisroom

import (
	"context"
	"errors"
	"time"

	"github.com/redis/go-redis/v9"
)

var establishConnectionScript = redis.NewScript(`
local t=redis.call('TIME')
local now=t[1]*1000+math.floor(t[2]/1000)
local expires=tonumber(redis.call('ZSCORE',KEYS[1],ARGV[1]))
if not expires or expires<=now then return 0 end
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
redis.call('ZADD',KEYS[2],expires,ARGV[1])
redis.call('PEXPIRE',KEYS[2],ARGV[2])
return 1`)

var presenceSnapshotScript = redis.NewScript(`
local t=redis.call('TIME')
local now=t[1]*1000+math.floor(t[2]/1000)
return redis.call('ZCOUNT',KEYS[1],'('..now,'+inf')`)

func connectionOnlineKey(userID string) string { return connectionUserKey(userID, "online") }

func (c *Client) EstablishConnectionLease(ctx context.Context, userID, leaseID string) (bool, error) {
	if !validConnectionUserID(userID) || leaseID == "" {
		return false, errors.New("invalid connection lease")
	}
	result, err := establishConnectionScript.Run(ctx, c.redis, []string{connectionLeaseKey(userID), connectionOnlineKey(userID)}, leaseID, ConnectionLeaseTTL.Milliseconds()).Int64()
	return result == 1, err
}

func (c *Client) Presence(ctx context.Context, userIDs []string) (map[string]bool, error) {
	if len(userIDs) < 1 || len(userIDs) > 100 {
		return nil, errors.New("presence batch must contain 1 to 100 users")
	}
	pipe := c.redis.Pipeline()
	commands := make([]*redis.Cmd, len(userIDs))
	for index, userID := range userIDs {
		if !validConnectionUserID(userID) {
			return nil, errors.New("invalid presence target")
		}
		commands[index] = presenceSnapshotScript.Eval(ctx, pipe, []string{connectionOnlineKey(userID)})
	}
	if _, err := pipe.Exec(ctx); err != nil {
		return nil, err
	}
	result := make(map[string]bool, len(userIDs))
	for index, command := range commands {
		count, err := command.Int64()
		if err != nil {
			return nil, err
		}
		result[userIDs[index]] = count > 0
	}
	return result, nil
}

func (c *Client) AllowPresenceWatch(ctx context.Context, userID string) (bool, error) {
	return c.allowAttempt(ctx, userID, 1, 10, 10*time.Second, "presence")
}
