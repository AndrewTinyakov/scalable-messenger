package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
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
	progress.epoch, progress.streamID = "", ""
	for range 100 {
		var page struct {
			Messages []event `json:"messages"`
			HasMore  bool    `json:"hasMore"`
		}
		path := "/chats/" + chatID + "/messages?afterSeq=" + strconv.FormatUint(progress.sequence, 10) + "&limit=100"
		if err := socket.owner.api(ctx, socket.session.Cookie, http.MethodGet, path, nil, &page); err != nil {
			return err
		}
		for _, message := range page.Messages {
			if message.ChatID != chatID {
				return errors.New("mixed recovery returned a message for another chat")
			}
			if err := socket.saved(message); err != nil {
				return err
			}
		}
		if !page.HasMore {
			return nil
		}
		if len(page.Messages) == 0 {
			return errors.New("SQL recovery returned an empty intermediate page")
		}
	}
	return errors.New("SQL recovery exceeded 100 bounded pages")
}
