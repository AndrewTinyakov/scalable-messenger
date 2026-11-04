package main

import (
	"context"
	"fmt"
	"strconv"
)

func (socket *client) subscribeMixed() error {
	if len(socket.chats) == 0 {
		socket.readyOnce.Do(func() { close(socket.ready) })
		return nil
	}
	for _, chat := range socket.owner.mixed.memberships[socket.session.UserID] {
		progress := socket.chats[chat.id]
		frame := map[string]any{"type": "subscribe", "chatId": chat.id, "kind": "GROUP", "lastAppliedSequence": strconv.FormatUint(progress.sequence, 10)}
		if progress.epoch != "" && progress.streamID != "" {
			frame["epoch"], frame["streamId"] = progress.epoch, progress.streamID
		}
		if err := socket.send(frame); err != nil {
			return err
		}
	}
	return nil
}

func (socket *client) subscribedMixed(chatID string) error {
	progress := socket.chats[chatID]
	if progress == nil {
		return fmt.Errorf("subscription for unassigned mixed chat %s", chatID)
	}
	progress.subscribed = true
	for _, chat := range socket.chats {
		if !chat.subscribed {
			return nil
		}
	}
	socket.readyOnce.Do(func() { close(socket.ready) })
	return nil
}

func (socket *client) recoverMixed(ctx context.Context, chatID string) error {
	progress := socket.chats[chatID]
	if progress == nil {
		return fmt.Errorf("recovery for unassigned mixed chat %s", chatID)
	}
	return socket.recoverChat(ctx, chatID, progress)
}
