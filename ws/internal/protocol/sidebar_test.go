package protocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestSharedSidebarContracts(t *testing.T) {
	for _, name := range []string{"watch-sidebar", "sidebar-activity"} {
		data, err := os.ReadFile("../../../contracts/fixtures/valid/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		decode := func(data []byte) error {
			if name == "watch-sidebar" {
				_, err := DecodeFrame(data)
				return err
			}
			_, err := DecodeSidebarEvent(data)
			return err
		}
		if err := decode(data); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var value map[string]any
		if err := json.Unmarshal(data, &value); err != nil {
			t.Fatal(err)
		}
		value["body"] = "forbidden"
		invalid, _ := json.Marshal(value)
		if decode(invalid) == nil {
			t.Fatalf("%s accepted body", name)
		}
	}
	for _, ids := range []any{nil, []string{testID, testID}, make([]string, 101), []string{"invalid"}} {
		data, _ := json.Marshal(map[string]any{"type": "watch_sidebar", "version": 1, "chatIds": ids})
		if _, err := DecodeFrame(data); err == nil {
			t.Fatalf("accepted targets %v", ids)
		}
	}
	if _, err := DecodeFrame([]byte(`{"type":"watch_sidebar","version":1,"chatIds":[]}`)); err != nil {
		t.Fatal(err)
	}
}

func TestSidebarActivityMessagePreview(t *testing.T) {
	data, err := os.ReadFile("../../../contracts/fixtures/valid/sidebar-activity-message.json")
	if err != nil {
		t.Fatal(err)
	}
	event, err := DecodeSidebarEvent(data)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(event)
	if err != nil {
		t.Fatal(err)
	}
	var forwarded, original map[string]any
	_ = json.Unmarshal(encoded, &forwarded)
	_ = json.Unmarshal(data, &original)
	for key, value := range original {
		if forwarded[key] != value {
			t.Fatalf("forwarded %s as %v, want %v", key, forwarded[key], value)
		}
	}
	for name, change := range map[string]func(map[string]any){
		"partial":        func(v map[string]any) { delete(v, "preview") },
		"long preview":   func(v map[string]any) { v["preview"] = strings.Repeat("x", 161) },
		"empty preview":  func(v map[string]any) { v["preview"] = "" },
		"bad username":   func(v map[string]any) { v["senderUsername"] = "Not Valid" },
		"bad created at": func(v map[string]any) { v["createdAt"] = "yesterday" },
	} {
		value := map[string]any{}
		_ = json.Unmarshal(data, &value)
		change(value)
		invalid, _ := json.Marshal(value)
		if _, err := DecodeSidebarEvent(invalid); err == nil {
			t.Fatalf("accepted %s", name)
		}
	}
	value := map[string]any{}
	_ = json.Unmarshal(data, &value)
	value["preview"] = strings.Repeat("😀", 160)
	wide, _ := json.Marshal(value)
	if _, err := DecodeSidebarEvent(wide); err != nil {
		t.Fatalf("preview length must count code points: %v", err)
	}
}
