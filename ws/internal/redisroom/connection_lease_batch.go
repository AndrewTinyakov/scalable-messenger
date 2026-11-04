package redisroom

import (
	"context"
	"errors"

	"github.com/redis/go-redis/v9"
)

type ConnectionLease struct {
	UserID  string
	LeaseID string
}

type ConnectionLeaseResult struct {
	Active bool
	Err    error
}

func (c *Client) RenewConnectionLeases(ctx context.Context, leases []ConnectionLease) []ConnectionLeaseResult {
	results := make([]ConnectionLeaseResult, len(leases))
	for start := 0; start < len(leases); start += 128 {
		batch := leases[start:min(start+128, len(leases))]
		commands := make([]*redis.Cmd, len(batch))
		pipe := c.redis.Pipeline()
		for index, lease := range batch {
			if !validConnectionUserID(lease.UserID) || lease.LeaseID == "" {
				results[start+index].Err = errors.New("invalid connection lease")
				continue
			}
			commands[index] = renewConnectionScript.Eval(ctx, pipe, []string{connectionLeaseKey(lease.UserID), connectionOnlineKey(lease.UserID)}, ConnectionLeaseTTL.Milliseconds(), lease.LeaseID)
		}
		_, _ = pipe.Exec(ctx)
		for index, command := range commands {
			if command == nil {
				continue
			}
			value, err := command.Int64()
			results[start+index] = ConnectionLeaseResult{Active: value == 1, Err: err}
		}
	}
	return results
}
