package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func (socket *client) saved(frame event) error {
	return socket.savedAt(frame, time.Now(), "recovery")
}

func (socket *client) savedAt(frame event, receivedAt time.Time, source string) error {
	progress := &chatProgress{sequence: socket.sequence, epoch: socket.epoch, streamID: socket.streamID}
	if socket.owner.mixed != nil {
		var ok bool
		progress, ok = socket.chats[frame.ChatID]
		if !ok {
			return fmt.Errorf("notification for unassigned mixed chat %s", frame.ChatID)
		}
	} else {
		defer func() {
			socket.sequence, socket.epoch, socket.streamID = progress.sequence, progress.epoch, progress.streamID
		}()
	}
	return socket.applySaved(frame, receivedAt, source, progress)
}

func (socket *client) applySaved(frame event, receivedAt time.Time, source string, progress *chatProgress) error {
	sequence, err := strconv.ParseUint(frame.Sequence, 10, 64)
	if err != nil {
		return err
	}
	if sequence > progress.sequence+1 {
		socket.owner.errors.Add(1)
		return fmt.Errorf("message sequence skipped from %d to %d", progress.sequence, sequence)
	}
	if strings.HasPrefix(frame.Body, socket.owner.prefix) {
		stamp := strings.SplitN(strings.TrimPrefix(frame.Body, socket.owner.prefix), "|", 2)[0]
		if nanos, err := strconv.ParseInt(stamp, 10, 64); err == nil {
			sentAt := time.Unix(0, nanos)
			record := traceRecord{Kind: "notification", Socket: socket.index, RequestID: frame.RequestID, EventID: frame.EventID, Sequence: frame.Sequence, SentAt: sentAt, CreatedAt: frame.CreatedAt, ObservedAt: receivedAt, Source: source}
			if source == "recovery" {
				socket.owner.trace.recordRecovery(record, frame.SenderID)
			} else {
				socket.owner.trace.record(record)
			}
			if sequence > progress.sequence {
				socket.owner.observe(receivedAt.Sub(sentAt))
			}
		}
		if sequence > progress.sequence {
			socket.delivered.Add(1)
			progress.delivered.Add(1)
		} else {
			socket.duplicates.Add(1)
		}
	}
	if sequence == progress.sequence+1 {
		progress.sequence = sequence
		if frame.Epoch != "" && frame.StreamID != "" {
			progress.epoch, progress.streamID = frame.Epoch, frame.StreamID
		}
		ack := map[string]any{"type": "applied", "chatId": frame.ChatID, "sequence": frame.Sequence}
		if frame.Epoch != "" && frame.StreamID != "" {
			ack["epoch"], ack["streamId"] = frame.Epoch, frame.StreamID
		}
		return socket.send(ack)
	}
	return socket.send(map[string]any{"type": "received_message", "chatId": frame.ChatID, "sequence": frame.Sequence})
}

func (socket *client) recover(ctx context.Context) error {
	socket.epoch, socket.streamID = "", ""
	for range 100 {
		var page struct {
			Messages []event `json:"messages"`
			HasMore  bool    `json:"hasMore"`
		}
		path := "/chats/" + socket.owner.manifest.GroupID + "/messages?afterSeq=" + strconv.FormatUint(socket.sequence, 10) + "&limit=100"
		if err := socket.owner.api(ctx, socket.session.Cookie, http.MethodGet, path, nil, &page); err != nil {
			return err
		}
		for _, message := range page.Messages {
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
