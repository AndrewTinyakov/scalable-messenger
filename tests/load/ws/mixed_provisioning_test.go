package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestMixedProvisioningAcceptsLegacySessionsAndReusesSavedGroups(t *testing.T) {
	var created, loaded atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Cookie") != "messenger_session=test" {
			http.Error(writer, "missing session", http.StatusUnauthorized)
			return
		}
		writer.Header().Set("Content-Type", "application/json")
		if request.Method == http.MethodPost && request.URL.Path == "/v1/chats/groups" {
			var body struct {
				Name    string   `json:"name"`
				Members []string `json:"memberIds"`
			}
			if err := json.NewDecoder(request.Body).Decode(&body); err != nil || len(body.Members) != 2 && len(body.Members) != 9 {
				http.Error(writer, "invalid group membership", http.StatusBadRequest)
				return
			}
			json.NewEncoder(writer).Encode(map[string]any{"id": fmt.Sprintf("chat-%d", created.Add(1))})
			return
		}
		if request.Method == http.MethodGet && strings.HasPrefix(request.URL.Path, "/v1/chats/chat-") {
			loaded.Add(1)
			json.NewEncoder(writer).Encode(map[string]any{"lastSequence": "7"})
			return
		}
		http.Error(writer, "unexpected request", http.StatusBadRequest)
	}))
	defer server.Close()
	directory := t.TempDir()
	legacyPath, scenarioPath, savedPath := filepath.Join(directory, "legacy.json"), filepath.Join(directory, "scenario.json"), filepath.Join(directory, "saved.json")
	for path, value := range map[string]any{legacyPath: manifest{Sessions: mixedSessions(20)}, scenarioPath: mixedFixture()} {
		payload, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, payload, 0600); err != nil {
			t.Fatal(err)
		}
	}
	opts := options{mode: "mixed", apiURL: server.URL, sessionsFile: legacyPath, saveSessions: savedPath, scenarioFile: scenarioPath, connections: 20, duration: time.Second, maxMessages: 10000}
	work := &run{opts: opts, http: server.Client()}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := work.prepare(ctx); err != nil {
		t.Fatal(err)
	}
	if created.Load() != 8 || loaded.Load() != 8 || len(work.manifest.MixedChats) != 8 {
		t.Fatalf("created %d, loaded %d, manifest chats %d", created.Load(), loaded.Load(), len(work.manifest.MixedChats))
	}
	for _, chat := range work.mixed.chats {
		if chat.baseline != 7 {
			t.Fatal("initial sequence was not loaded")
		}
	}
	opts.sessionsFile, opts.saveSessions = savedPath, ""
	reused := &run{opts: opts, http: server.Client()}
	if err := reused.prepare(ctx); err != nil {
		t.Fatal(err)
	}
	if created.Load() != 8 || loaded.Load() != 16 {
		t.Fatal("saved groups were not reused")
	}
	routed := 0
	for _, account := range reused.mixed.users {
		for _, progress := range reused.mixed.clientChats(account.UserID) {
			routed++
			if progress.sequence != 7 {
				t.Fatal("socket lost the reused chat baseline")
			}
		}
	}
	if routed != 38 {
		t.Fatalf("routed %d user/chat subscriptions, want 38", routed)
	}
	changed := mixedFixture()
	changed.Seed++
	payload, err := json.Marshal(changed)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(scenarioPath, payload, 0600); err != nil {
		t.Fatal(err)
	}
	mismatched := &run{opts: opts, http: server.Client()}
	if err := mismatched.prepare(ctx); err == nil {
		t.Fatal("accepted saved groups with a different seeded membership")
	}
	if created.Load() != 8 {
		t.Fatal("mismatched saved scenario created replacement groups")
	}
}
