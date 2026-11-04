package protocol

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedSidebarContracts(t *testing.T) {
	for _, name := range []string{"watch-sidebar", "sidebar-activity", "sidebar-presence"} {
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
