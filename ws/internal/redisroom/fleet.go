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
)

func connectionCountKey(userID string) string { return connectionUserKey(userID, "count") }

func gatewayUsersKey(gateway string) string { return "messenger:gateway:{" + gateway + "}:users" }

func gatewayDeadKey(gateway string) string { return "messenger:gateway:{" + gateway + "}:dead" }

func gatewayReapingKey(gateway string) string { return "messenger:gateway:{" + gateway + "}:reaping" }

func (c *Client) AdmitConnection(ctx context.Context, userID, gateway string, limit int) (bool, error) {
	if !validConnectionUserID(userID) || gateway == "" {
		return false, errors.New("invalid connection admission")
	}
	if err := c.redis.SAdd(ctx, gatewayUsersKey(gateway), userID).Err(); err != nil {
		return false, fmt.Errorf("index connection: %w", err)
	}
	admitted, err := admitConnectionScript.Run(ctx, c.redis, []string{connectionCountKey(userID)}, gateway, limit).Int64()
	if err != nil {
		return false, fmt.Errorf("admit connection: %w", err)
	}
	return admitted == 1, nil
}

func (c *Client) UnindexConnections(ctx context.Context, userID, gateway string) error {
	return c.redis.SRem(ctx, gatewayUsersKey(gateway), userID).Err()
}

func (c *Client) SetConnections(ctx context.Context, userID, gateway string, count int) error {
	if !validConnectionUserID(userID) || gateway == "" || count < 0 {
		return errors.New("invalid connection count")
	}
	if count > 0 {
		if err := c.redis.SAdd(ctx, gatewayUsersKey(gateway), userID).Err(); err != nil {
			return err
		}
	}
	var err error
	if count > 0 {
		err = c.redis.HSet(ctx, connectionCountKey(userID), gateway, count).Err()
	} else {
		err = c.redis.HDel(ctx, connectionCountKey(userID), gateway).Err()
	}
	if err != nil {
		return fmt.Errorf("set connections: %w", err)
	}
	return nil
}

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

func (c *Client) ClaimGateway(ctx context.Context, gateway string) (bool, error) {
	claimed, err := c.redis.SetNX(ctx, gatewayReapingKey(gateway), 1, time.Minute).Result()
	if err != nil || !claimed {
		return false, err
	}
	deadline, err := c.redis.ZScore(ctx, gatewaysKey, gateway).Result()
	if err == nil && int64(deadline) > time.Now().UnixMilli() {
		return false, c.redis.Del(ctx, gatewayReapingKey(gateway)).Err()
	}
	if err != nil && !errors.Is(err, redis.Nil) {
		return false, err
	}
	return true, c.redis.Set(ctx, gatewayDeadKey(gateway), 1, 24*time.Hour).Err()
}

func (c *Client) GatewayUsers(ctx context.Context, gateway string, cursor uint64) ([]string, uint64, error) {
	return c.redis.SScan(ctx, gatewayUsersKey(gateway), cursor, "", 500).Result()
}

func (c *Client) ForgetGateway(ctx context.Context, gateway string) error {
	if err := c.redis.Del(ctx, gatewayUsersKey(gateway)).Err(); err != nil {
		return err
	}
	return c.redis.ZRem(ctx, gatewaysKey, gateway).Err()
}
