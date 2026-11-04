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
	progress := &chatProgress{sequence: socket.sequence}
	defer func() {
		socket.sequence, socket.epoch, socket.streamID = progress.sequence, progress.epoch, progress.streamID
	}()
	return socket.recoverChat(ctx, socket.owner.manifest.GroupID, progress)
}

type historyPage struct {
	Messages                []event `json:"messages"`
	HasMore                 bool    `json:"hasMore"`
	NextSequence            string  `json:"nextSequence"`
	CoverageAfterSequence   string  `json:"coverageAfterSequence"`
	CoverageThroughSequence string  `json:"coverageThroughSequence"`
}

func (socket *client) recoverChat(ctx context.Context, chatID string, progress *chatProgress) error {
	progress.epoch, progress.streamID = "", ""
	for range 100 {
		var page historyPage
		start := progress.sequence
		path := "/chats/" + chatID + "/messages?afterSeq=" + strconv.FormatUint(start, 10) + "&limit=100"
		if err := socket.owner.api(ctx, socket.session.Cookie, http.MethodGet, path, nil, &page); err != nil {
			return err
		}
		if err := socket.applyHistoryPage(chatID, progress, page); err != nil {
			return err
		}
		if !page.HasMore {
			return nil
		}
		if progress.sequence <= start {
			return errors.New("SQL recovery continuation did not advance")
		}
	}
	return errors.New("SQL recovery exceeded 100 bounded pages")
}

func (socket *client) applyHistoryPage(chatID string, progress *chatProgress, page historyPage) error {
	certified := page.CoverageAfterSequence != "" || page.CoverageThroughSequence != ""
	var through uint64
	if certified {
		after, err := strconv.ParseUint(page.CoverageAfterSequence, 10, 64)
		if err != nil || after != progress.sequence {
			return errors.New("SQL recovery coverage starts at an unexpected sequence")
		}
		through, err = strconv.ParseUint(page.CoverageThroughSequence, 10, 64)
		if err != nil || through < after || page.NextSequence != page.CoverageThroughSequence {
			return errors.New("SQL recovery coverage and continuation disagree")
		}
	}
	for _, message := range page.Messages {
		if message.ChatID != chatID {
			return errors.New("SQL recovery returned a message for another chat")
		}
		if certified {
			sequence, err := strconv.ParseUint(message.Sequence, 10, 64)
			if err != nil || sequence <= progress.sequence || sequence > through {
				return errors.New("SQL recovery row is outside certified coverage")
			}
			progress.sequence = sequence - 1
		}
		if err := socket.applySaved(message, time.Now(), "recovery", progress); err != nil {
			return err
		}
	}
	if certified && through > progress.sequence {
		progress.sequence = through
		return socket.send(map[string]any{"type": "applied", "chatId": chatID, "sequence": strconv.FormatUint(through, 10)})
	}
	return nil
}
