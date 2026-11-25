package redisroom

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const gatewaysKey = "messenger:gateways"

var (
	admitConnectionScript = redis.NewScript(`
local total=0
local fields=redis.call('HGETALL',KEYS[1])
for i=1,#fields,2 do total=total+tonumber(fields[i+1]) end
if total>=tonumber(ARGV[2]) then return 0 end
redis.call('HINCRBY',KEYS[1],ARGV[1],1)
return 1`)
	setConnectionsScript = redis.NewScript(`
local count=tonumber(ARGV[2])
if count>0 then redis.call('HSET',KEYS[1],ARGV[1],count) else redis.call('HDEL',KEYS[1],ARGV[1]) end
return 1`)
)

func connectionCountKey(userID string) string { return connectionUserKey(userID, "count") }

func gatewayUsersKey(gateway string) string { return "messenger:gateway:{" + gateway + "}:users" }

func gatewayDeadKey(gateway string) string { return "messenger:gateway:{" + gateway + "}:dead" }

func gatewayReapingKey(gateway string) string { return "messenger:gateway:{" + gateway + "}:reaping" }

// AdmitConnection adds one connection for the user on this gateway when the
// fleet-wide total stays within limit.
func (c *Client) AdmitConnection(ctx context.Context, userID, gateway string, limit int) (bool, error) {
	if !validConnectionUserID(userID) || gateway == "" {
		return false, errors.New("invalid connection admission")
	}
	admitted, err := admitConnectionScript.Run(ctx, c.redis, []string{connectionCountKey(userID)}, gateway, limit).Int64()
	if err != nil {
		return false, fmt.Errorf("admit connection: %w", err)
	}
	if admitted == 1 {
		err = c.redis.SAdd(ctx, gatewayUsersKey(gateway), userID).Err()
	}
	return admitted == 1, err
}

// SetConnections writes this gateway's absolute connection count for a user.
func (c *Client) SetConnections(ctx context.Context, userID, gateway string, count int) error {
	if !validConnectionUserID(userID) || gateway == "" || count < 0 {
		return errors.New("invalid connection count")
	}
	if err := setConnectionsScript.Run(ctx, c.redis, []string{connectionCountKey(userID)}, gateway, count).Err(); err != nil {
		return fmt.Errorf("set connections: %w", err)
	}
	if count > 0 {
		return c.redis.SAdd(ctx, gatewayUsersKey(gateway), userID).Err()
	}
	return c.redis.SRem(ctx, gatewayUsersKey(gateway), userID).Err()
}

// Heartbeat extends this gateway's registration. It reports registered=false
// when Redis had lost the registration and dead=true once another gateway
// has removed it.
func (c *Client) Heartbeat(ctx context.Context, gateway string, ttl time.Duration) (registered, dead bool, err error) {
	marked, err := c.redis.Exists(ctx, gatewayDeadKey(gateway)).Result()
	if err != nil || marked == 1 {
		return false, marked == 1, err
	}
	added, err := c.redis.ZAdd(ctx, gatewaysKey, redis.Z{Score: float64(time.Now().Add(ttl).UnixMilli()), Member: gateway}).Result()
	if err != nil {
		return false, false, fmt.Errorf("gateway heartbeat: %w", err)
	}
	return added == 0, false, nil
}

func (c *Client) ExpiredGateways(ctx context.Context, limit int64) ([]string, error) {
	return c.redis.ZRangeArgs(ctx, redis.ZRangeArgs{Key: gatewaysKey, Start: "-inf", Stop: time.Now().UnixMilli(), ByScore: true, Count: limit}).Result()
}

// ClaimGateway lets one caller remove an expired gateway's state. The claim
// expires so another gateway can finish an interrupted removal.
func (c *Client) ClaimGateway(ctx context.Context, gateway string) (bool, error) {
	return c.redis.SetNX(ctx, gatewayReapingKey(gateway), 1, time.Minute).Result()
}

func (c *Client) GatewayUsers(ctx context.Context, gateway string, cursor uint64) ([]string, uint64, error) {
	return c.redis.SScan(ctx, gatewayUsersKey(gateway), cursor, "", 500).Result()
}

// ForgetGateway marks a removed gateway dead so a surviving process with
// that identity registers again under a new one.
func (c *Client) ForgetGateway(ctx context.Context, gateway string) error {
	if err := c.redis.Set(ctx, gatewayDeadKey(gateway), 1, 24*time.Hour).Err(); err != nil {
		return err
	}
	if err := c.redis.Del(ctx, gatewayUsersKey(gateway)).Err(); err != nil {
		return err
	}
	return c.redis.ZRem(ctx, gatewaysKey, gateway).Err()
}

func (c *Client) RemoveGatewayConnections(ctx context.Context, gateway string, userIDs []string) error {
	pipe := c.redis.Pipeline()
	for _, userID := range userIDs {
		pipe.HDel(ctx, connectionCountKey(userID), gateway)
	}
	_, err := pipe.Exec(ctx)
	return err
}
