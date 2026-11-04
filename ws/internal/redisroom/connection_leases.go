package redisroom

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"time"

	"github.com/redis/go-redis/v9"
)

const (
	MaxConnectionsPerUser        = 10
	ConnectionLeaseTTL           = 90 * time.Second
	ConnectionLeaseRenewInterval = 30 * time.Second
)

var (
	acquireConnectionScript = redis.NewScript(`
local t=redis.call('TIME')
local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if redis.call('ZCARD',KEYS[1])>=tonumber(ARGV[2]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[1]),ARGV[3])
redis.call('PEXPIRE',KEYS[1],ARGV[1])
return 1`)
	renewConnectionScript = redis.NewScript(`
local t=redis.call('TIME')
local now=t[1]*1000+math.floor(t[2]/1000)
redis.call('ZREMRANGEBYSCORE',KEYS[1],'-inf',now)
if not redis.call('ZSCORE',KEYS[1],ARGV[2]) then return 0 end
redis.call('ZADD',KEYS[1],now+tonumber(ARGV[1]),ARGV[2])
redis.call('PEXPIRE',KEYS[1],ARGV[1])
redis.call('ZREMRANGEBYSCORE',KEYS[2],'-inf',now)
if redis.call('ZSCORE',KEYS[2],ARGV[2]) then
redis.call('ZADD',KEYS[2],now+tonumber(ARGV[1]),ARGV[2])
redis.call('PEXPIRE',KEYS[2],ARGV[1])
end
return 1`)
	releaseConnectionScript = redis.NewScript(`
redis.call('ZREM',KEYS[1],ARGV[1])
if redis.call('ZCARD',KEYS[1])==0 then redis.call('DEL',KEYS[1]) end
redis.call('ZREM',KEYS[2],ARGV[1])
if redis.call('ZCARD',KEYS[2])==0 then redis.call('DEL',KEYS[2]) end
return 1`)
	allowAttemptScript = redis.NewScript(`
local t=redis.call('TIME')
local now=t[1]*1000000+t[2]
local interval=tonumber(ARGV[1])/tonumber(ARGV[2])
local cost=tonumber(ARGV[4])
local tat=tonumber(redis.call('GET',KEYS[1])) or now
if now<tat-(tonumber(ARGV[2])-cost)*interval then return 0 end
local nextTat=math.max(now,tat)+cost*interval
redis.call('SET',KEYS[1],string.format('%.0f',nextTat),'PX',ARGV[3])
return 1`)
)

// Connection leases share one Redis Cluster slot per user. Hashing keeps
// untrusted identifier bytes out of the Redis key and hash tag.
func connectionLeaseKey(userID string) string {
	return connectionUserKey(userID, "leases")
}

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

// AcquireConnectionLease reserves one of ten fleet-wide connection slots.
// The caller must renew the returned lease while the socket is open and
// release it on close. Redis errors must fail the handshake closed. After a
// node crash, its slots expire automatically at ConnectionLeaseTTL.
func (c *Client) AcquireConnectionLease(ctx context.Context, userID string) (leaseID string, allowed bool, err error) {
	if !validConnectionUserID(userID) {
		return "", false, errors.New("invalid connection user ID")
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return "", false, fmt.Errorf("generate connection lease ID: %w", err)
	}
	leaseID = base64.RawURLEncoding.EncodeToString(nonce[:])
	result, err := acquireConnectionScript.Run(ctx, c.redis, []string{connectionLeaseKey(userID)}, ConnectionLeaseTTL.Milliseconds(), MaxConnectionsPerUser, leaseID).Int64()
	if err != nil {
		return leaseID, false, fmt.Errorf("acquire connection lease: %w", err)
	}
	return leaseID, result == 1, nil
}

// RenewConnectionLease cannot recreate an expired or released lease. A false
// result means the socket no longer owns a slot and must close.
func (c *Client) RenewConnectionLease(ctx context.Context, userID, leaseID string) (bool, error) {
	if !validConnectionUserID(userID) || leaseID == "" {
		return false, errors.New("invalid connection lease")
	}
	result, err := renewConnectionScript.Run(ctx, c.redis, []string{connectionLeaseKey(userID), connectionOnlineKey(userID)}, ConnectionLeaseTTL.Milliseconds(), leaseID).Int64()
	if err != nil {
		return false, fmt.Errorf("renew connection lease: %w", err)
	}
	return result == 1, nil
}

// ReleaseConnectionLease is idempotent. Call it with a bounded cleanup
// context, independent of the canceled socket context.
func (c *Client) ReleaseConnectionLease(ctx context.Context, userID, leaseID string) error {
	if !validConnectionUserID(userID) || leaseID == "" {
		return errors.New("invalid connection lease")
	}
	if err := releaseConnectionScript.Run(ctx, c.redis, []string{connectionLeaseKey(userID), connectionOnlineKey(userID)}, leaseID).Err(); err != nil {
		return fmt.Errorf("release connection lease: %w", err)
	}
	return nil
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
// connection lease so rejected attempts do not occupy a slot.
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
