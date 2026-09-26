package protocol

import (
	"encoding/json"
	"strings"
	"testing"

	"messenger/ws/internal/generated/messaging"
)

const testID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

func TestDecodeFrame(t *testing.T) {
	cases := []struct {
		name, input string
		wantError   bool
	}{
		{"valid send", `{"type":"send","version":1,"conversationId":"` + testID + `","requestId":"` + testID + `","body":"hello"}`, false},
		{"unknown field", `{"type":"send","version":1,"conversationId":"` + testID + `","requestId":"` + testID + `","body":"hello","extra":1}`, true},
		{"trailing value", `{"type":"subscribe","version":1,"conversationId":"` + testID + `"} {}`, true},
		{"missing body", `{"type":"send","version":1,"conversationId":"` + testID + `","requestId":"` + testID + `"}`, true},
		{"invalid ID", `{"type":"subscribe","version":1,"conversationId":"lowercase"}`, true},
		{"unsupported version", `{"type":"subscribe","version":2,"conversationId":"` + testID + `"}`, true},
		{"incomplete cursor", `{"type":"subscribe","version":1,"conversationId":"` + testID + `","epoch":"e"}`, true},
		{"invalid sequence", `{"type":"applied","version":1,"conversationId":"` + testID + `","sequence":4}`, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := DecodeFrame([]byte(tc.input))
			if (err != nil) != tc.wantError {
				t.Fatalf("error = %v, want error = %v", err, tc.wantError)
			}
		})
	}
}

func TestCommandMatchesGeneratedWire(t *testing.T) {
	command := SendCommand{Version: 1, ConversationID: testID, RequestID: testID, SenderID: testID, Body: "hello", SentAt: "2026-09-26T10:00:00Z"}
	raw, err := json.Marshal(command.Wire())
	if err != nil {
		t.Fatal(err)
	}
	var wire messaging.SendMessageCommandV1
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.ConversationId != command.ConversationID || wire.RequestId != command.RequestID || wire.Body != command.Body {
		t.Fatalf("wire = %+v", wire)
	}
}

func TestDecodeFrameBodyCountsUnicodeCodePoints(t *testing.T) {
	input := `{"type":"send","version":1,"conversationId":"` + testID + `","requestId":"` + testID + `","body":"` + strings.Repeat("🙂", 4000) + `"}`
	if _, err := DecodeFrame([]byte(input)); err != nil {
		t.Fatalf("4000 code point body: %v", err)
	}
	input = `{"type":"send","version":1,"conversationId":"` + testID + `","requestId":"` + testID + `","body":"` + strings.Repeat("🙂", 4001) + `"}`
	if _, err := DecodeFrame([]byte(input)); err == nil {
		t.Fatal("4001 code point body accepted")
	}
}

func TestDecodeEventRejectsMalformedOrUnknownPayload(t *testing.T) {
	valid := `{"type":"message_saved","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","conversationId":"` + testID + `","requestId":"` + testID + `","messageId":"` + testID + `","sequence":"1","senderId":"` + testID + `","body":"hello","createdAt":"2026-09-26T10:00:00Z"}`
	if _, err := DecodeEvent([]byte(valid)); err != nil {
		t.Fatalf("valid event: %v", err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"sequence":"1"`, `"sequence":1`, 1),
		strings.Replace(valid, `"type":"message_saved"`, `"type":"unknown"`, 1),
		strings.Replace(valid, `"body":"hello"`, `"body":"hello","surprise":true`, 1),
		valid + ` {}`,
	} {
		if _, err := DecodeEvent([]byte(raw)); err == nil {
			t.Fatalf("accepted malformed event: %s", raw)
		}
	}
}

func TestDecodeEventAcceptsTerminalProcessingFailure(t *testing.T) {
	raw := `{"type":"send_rejected","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","conversationId":"` + testID + `","requestId":"` + testID + `","reason":"PROCESSING_FAILED"}`
	event, err := DecodeEvent([]byte(raw))
	if err != nil {
		t.Fatalf("DecodeEvent() error = %v", err)
	}
	if event.Reason != "PROCESSING_FAILED" {
		t.Fatalf("reason = %q, want PROCESSING_FAILED", event.Reason)
	}
}
