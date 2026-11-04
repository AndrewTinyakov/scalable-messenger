package redisroom

import (
	"context"
	"errors"
	"fmt"

	"github.com/redis/go-redis/v9"
)

type Position struct {
	Epoch    string
	StreamID string
	Err      error
}

const tailScript = `local epoch=redis.call('GET',KEYS[1]) or ''; local entries=redis.call('XREVRANGE',KEYS[2],'+','-','COUNT',1); local tail=''; if #entries>0 then tail=entries[1][1] end; return {epoch,tail}`

func (c *Client) TailBatch(ctx context.Context, rooms []string) (map[string]Position, error) {
	positions := make(map[string]Position, len(rooms))
	for start := 0; start < len(rooms); start += 128 {
		batch := rooms[start:min(start+128, len(rooms))]
		commands := make(map[string]*redis.Cmd, len(batch))
		pipe := c.redis.Pipeline()
		for _, room := range batch {
			if !validRoom(room) {
				positions[room] = Position{Err: errors.New("invalid room")}
				continue
			}
			commands[room] = pipe.Eval(ctx, tailScript, []string{EpochKey(room), StreamKey(room)})
		}
		_, _ = pipe.Exec(ctx)
		for room, command := range commands {
			values, err := command.StringSlice()
			if err != nil {
				positions[room] = Position{Err: err}
			} else if len(values) != 2 {
				positions[room] = Position{Err: fmt.Errorf("invalid Redis room position")}
			} else {
				positions[room] = Position{Epoch: values[0], StreamID: values[1]}
			}
		}
	}
	return positions, ctx.Err()
}
