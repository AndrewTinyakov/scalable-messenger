package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"
)

func (work *run) prepareMixed(ctx context.Context) error {
	mixed := work.mixed
	if err := mixed.plan(work.manifest.Sessions, work.opts.connections, work.opts.duration, work.opts.maxMessages); err != nil {
		return err
	}
	reuse := len(work.manifest.MixedChats) > 0
	if reuse && len(work.manifest.MixedChats) != len(mixed.chats) {
		return errors.New("session manifest mixedChats count does not match seeded scenario")
	}
	chatIDs := make(map[string]bool)
	for index, chat := range mixed.chats {
		members := make([]string, 0, len(chat.members))
		for _, member := range chat.members {
			members = append(members, mixed.users[member].UserID)
		}
		creator := mixed.users[chat.members[0]]
		if reuse {
			existing := work.manifest.MixedChats[index]
			if existing.ID == "" || !slices.Equal(existing.Members, members) {
				return fmt.Errorf("session manifest mixed chat %d does not match seeded membership", index)
			}
			chat.id = existing.ID
		} else {
			var response struct {
				ID string `json:"id"`
			}
			if err := work.api(ctx, creator.Cookie, http.MethodPost, "/chats/groups", map[string]any{"name": "Capacity mixed " + strconv.Itoa(index), "memberIds": members[1:]}, &response); err != nil {
				return err
			}
			if response.ID == "" {
				return errors.New("group creation returned an empty chat ID")
			}
			chat.id = response.ID
			work.manifest.MixedChats = append(work.manifest.MixedChats, mixedChatManifest{ID: chat.id, Members: members})
		}
		if chatIDs[chat.id] {
			return errors.New("mixed scenario cannot reuse one chat ID for multiple groups")
		}
		chatIDs[chat.id] = true
		var response struct {
			LastSequence string `json:"lastSequence"`
		}
		if err := work.api(ctx, creator.Cookie, http.MethodGet, "/chats/"+chat.id, nil, &response); err != nil {
			return err
		}
		baseline, err := strconv.ParseUint(response.LastSequence, 10, 64)
		if err != nil {
			return fmt.Errorf("invalid mixed chat baseline: %w", err)
		}
		chat.baseline = baseline
	}
	return nil
}

func (mixed *mixedWorkload) clientChats(userID string) map[string]*chatProgress {
	progress := make(map[string]*chatProgress)
	for _, chat := range mixed.memberships[userID] {
		progress[chat.id] = &chatProgress{chat: chat, sequence: chat.baseline}
	}
	return progress
}

func (work *run) mixedReport() map[string]any {
	mixed := work.mixed
	groups := make([]map[string]any, 0, len(mixed.chats))
	expected := int64(0)
	rates := make([]float64, len(mixed.users))
	for _, chat := range mixed.chats {
		for _, sender := range chat.senders {
			rates[sender] += chat.rate / float64(len(chat.senders))
		}
	}
	maxUserRate := 0.0
	for _, rate := range rates {
		maxUserRate = max(maxUserRate, rate)
	}
	socketCounts := make(map[string]int)
	receivedCounts := make(map[string]int64)
	for _, socket := range work.clients {
		for id, progress := range socket.chats {
			socketCounts[id]++
			receivedCounts[id] += progress.delivered.Load()
		}
	}
	for index, chat := range mixed.chats {
		sockets := socketCounts[chat.id]
		received := receivedCounts[chat.id]
		notifications := chat.sent.Load() * int64(sockets)
		expected += notifications
		groups = append(groups, map[string]any{
			"index":                 index,
			"chatId":                chat.id,
			"members":               len(chat.members),
			"sockets":               sockets,
			"activeSenders":         len(chat.senders),
			"messagesPerSecond":     chat.rate,
			"sent":                  chat.sent.Load(),
			"expectedNotifications": notifications,
			"receivedNotifications": received,
		})
	}
	return map[string]any{
		"seed":                               mixed.scenario.Seed,
		"users":                              len(mixed.users),
		"selectedActiveUsers":                mixed.selectedActiveUsers,
		"activeSenderUsers":                  mixed.activeUsers,
		"activeSenderFraction":               mixed.scenario.ActiveSenderFraction,
		"payloads":                           mixed.scenario.Payloads,
		"offeredMessagesPerSecond":           mixed.offeredRate,
		"meanMessagesPerSecondPerActiveUser": mixed.offeredRate / float64(max(1, mixed.activeUsers)),
		"maxMessagesPerSecondPerUser":        maxUserRate,
		"offeredNotificationsPerSecond":      mixed.offeredNotifications,
		"scheduled":                          len(mixed.schedule),
		"dispatched":                         mixed.dispatched.Load(),
		"queueDropped":                       mixed.queueDropped.Load(),
		"lateDropped":                        mixed.lateDropped.Load(),
		"cancelled":                          mixed.cancelled.Load(),
		"maxSendLag":                         mixedMaxSendLag.String(),
		"maxObservedSendLag":                 time.Duration(mixed.maxLag.Load()).String(),
		"maxWriterWait":                      time.Duration(mixed.maxWriteWait.Load()).String(),
		"queueCapacity":                      mixedQueueCapacity,
		"workers":                            min(mixedMaxWorkers, len(mixed.users)),
		"expectedNotifications":              expected,
		"groups":                             groups,
	}
}
