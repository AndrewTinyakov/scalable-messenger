package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
)

type session struct {
	UserID string `json:"userId"`
	Cookie string `json:"cookie"`
}

type manifest struct {
	Sessions   []session           `json:"sessions"`
	GroupID    string              `json:"groupId,omitempty"`
	MixedChats []mixedChatManifest `json:"mixedChats,omitempty"`
}

func (work *run) prepare(ctx context.Context) error {
	if work.opts.mode == "mixed" {
		scenario, err := readMixedScenario(work.opts.scenarioFile)
		if err != nil {
			return err
		}
		work.mixed = &mixedWorkload{scenario: scenario}
	}
	if work.opts.sessionsFile != "" {
		payload, err := os.ReadFile(work.opts.sessionsFile)
		if err != nil {
			return err
		}
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&work.manifest); err != nil {
			return err
		}
		var trailing any
		if err := decoder.Decode(&trailing); err != io.EOF {
			return errors.New("session manifest must contain one JSON object")
		}
	} else {
		if work.opts.bootstrapUsers < 1 {
			return errors.New("provide -sessions or -bootstrap-users")
		}
		for range work.opts.bootstrapUsers {
			var response struct {
				User struct {
					ID string `json:"id"`
				} `json:"user"`
			}
			cookie, err := work.register(ctx, map[string]any{"username": "cap_" + ulid(), "password": ulid() + ulid()}, &response)
			if err != nil {
				return err
			}
			work.manifest.Sessions = append(work.manifest.Sessions, session{UserID: response.User.ID, Cookie: cookie})
		}
	}
	if len(work.manifest.Sessions) == 0 {
		return errors.New("manifest has no sessions")
	}
	counts := make(map[string]int)
	for _, account := range work.manifest.Sessions {
		if account.UserID == "" || !(strings.HasPrefix(account.Cookie, "__Host-messenger_session=") || strings.HasPrefix(account.Cookie, "messenger_session=")) || strings.ContainsAny(account.Cookie, "\r\n;") {
			return errors.New("manifest contains an invalid session")
		}
	}
	for index := range work.opts.connections {
		counts[work.manifest.Sessions[index%len(work.manifest.Sessions)].UserID]++
	}
	for userID, count := range counts {
		if count > 10 {
			return fmt.Errorf("user %s would exceed 10 connections", userID)
		}
	}
	if work.mixed != nil {
		if err := work.prepareMixed(ctx); err != nil {
			return err
		}
	} else {
		if work.opts.groupID != "" {
			work.manifest.GroupID = work.opts.groupID
		}
		if work.opts.mode != "idle" && work.manifest.GroupID == "" {
			members := make([]string, 0, len(work.manifest.Sessions)-1)
			seen := map[string]bool{work.manifest.Sessions[0].UserID: true}
			for _, account := range work.manifest.Sessions[1:] {
				if !seen[account.UserID] {
					members = append(members, account.UserID)
					seen[account.UserID] = true
				}
			}
			if len(members) == 0 {
				return errors.New("group workloads need at least two distinct users")
			}
			var group struct {
				ID string `json:"id"`
			}
			if err := work.api(ctx, work.manifest.Sessions[0].Cookie, http.MethodPost, "/chats/groups", map[string]any{"name": "WebSocket capacity", "memberIds": members[:min(999, len(members))]}, &group); err != nil {
				return err
			}
			work.manifest.GroupID = group.ID
			for offset := 999; offset < len(members); offset += 1000 {
				if err := work.api(ctx, work.manifest.Sessions[0].Cookie, http.MethodPost, "/chats/"+group.ID+"/members", map[string]any{"memberIds": members[offset:min(offset+1000, len(members))]}, nil); err != nil {
					return err
				}
			}
		}
		if work.manifest.GroupID != "" {
			var chat struct {
				LastSequence string `json:"lastSequence"`
			}
			if err := work.api(ctx, work.manifest.Sessions[0].Cookie, http.MethodGet, "/chats/"+work.manifest.GroupID, nil, &chat); err != nil {
				return err
			}
			var err error
			work.baseline, err = strconv.ParseUint(chat.LastSequence, 10, 64)
			if err != nil {
				return fmt.Errorf("invalid initial chat sequence: %w", err)
			}
		}
	}
	if work.opts.saveSessions != "" {
		file, err := os.OpenFile(work.opts.saveSessions, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			return err
		}
		err = json.NewEncoder(file).Encode(work.manifest)
		return errors.Join(err, file.Close())
	}
	return nil
}
