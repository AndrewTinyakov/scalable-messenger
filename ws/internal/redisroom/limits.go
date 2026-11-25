package redisroom

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

var allowAttemptScript = redis.NewScript(`
local t=redis.call('TIME')
local now=t[1]*1000000+t[2]
local interval=tonumber(ARGV[1])/tonumber(ARGV[2])
local cost=tonumber(ARGV[4])
local tat=tonumber(redis.call('GET',KEYS[1])) or now
if now<tat-(tonumber(ARGV[2])-cost)*interval then return 0 end
local nextTat=math.max(now,tat)+cost*interval
redis.call('SET',KEYS[1],string.format('%.0f',nextTat),'PX',ARGV[3])
return 1`)

// Per-user connection keys share one Redis Cluster slot. Hashing keeps
// untrusted identifier bytes out of the Redis key and hash tag.
func connectionUserKey(userID, suffix string) string {
	digest := sha256.Sum256([]byte(userID))
	return "messenger:connection:{" + hex.EncodeToString(digest[:]) + "}:" + suffix
}

func subscribeLimitKey(userID string) string {
	return connectionUserKey(userID, "subscribe")
}

func handshakeLimitKey(userID string) string {
	return connectionUserKey(userID, "handshake")
}

func validConnectionUserID(userID string) bool {
	return userID != "" && len(userID) <= 256
}

// AllowSubscribe uses a Redis-time GCRA limit shared by all WS nodes. A
// burst of up to limit attempts is allowed within window; denied attempts
// do not extend the window. Apply it before each group authorization call.
func (c *Client) AllowSubscribe(ctx context.Context, userID string, limit int, window time.Duration) (bool, error) {
	return c.allowAttempt(ctx, userID, 1, limit, window, "subscribe")
}

// AllowSubscribeBatch charges one token for each requested chat in one atomic
// Redis operation, so a batch cannot bypass or partly consume the rate limit.
func (c *Client) AllowSubscribeBatch(ctx context.Context, userID string, count, limit int, window time.Duration) (bool, error) {
	return c.allowAttempt(ctx, userID, count, limit, window, "subscribe")
}

// AllowHandshake applies an independent per-user Redis-time GCRA limit to
// connection attempts. Check it after authentication and before acquiring a
// connection slot so rejected attempts do not occupy one.
func (c *Client) AllowHandshake(ctx context.Context, userID string, limit int, window time.Duration) (bool, error) {
	return c.allowAttempt(ctx, userID, 1, limit, window, "handshake")
}

func (c *Client) allowAttempt(ctx context.Context, userID string, cost, limit int, window time.Duration, operation string) (bool, error) {
	if !validConnectionUserID(userID) || limit <= 0 || cost <= 0 || cost > limit || window < time.Millisecond || window/time.Microsecond < time.Duration(limit) {
		return false, fmt.Errorf("invalid %s limit", operation)
	}
	key := connectionUserKey(userID, operation)
	result, err := allowAttemptScript.Run(ctx, c.redis, []string{key}, window.Microseconds(), limit, window.Milliseconds(), cost).Int64()
	if err != nil {
		return false, fmt.Errorf("limit %s attempts: %w", operation, err)
	}
	return result == 1, nil
}

// AllowPresenceWatch limits watch commands per user across all WS nodes:
// a burst of 30, refilled at three per second.
func (c *Client) AllowPresenceWatch(ctx context.Context, userID string) (bool, error) {
	return c.allowAttempt(ctx, userID, 1, 30, 10*time.Second, "presence")
}
