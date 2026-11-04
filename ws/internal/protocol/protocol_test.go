package protocol

import (
	"encoding/json"
	"os"
	"strings"
	"testing"

	"messenger/ws/internal/generated/messaging"
)

const testID = "01ARZ3NDEKTSV4RRFFQ69G5FAV"

func TestDecodeEventRejectsSharedConflictingTargets(t *testing.T) {
	payload, err := os.ReadFile("../../../contracts/fixtures/invalid/send-rejected-both-targets.json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeEvent(payload); err == nil {
		t.Fatal("accepted conflicting rejection targets")
	}
}

func TestDecodeFrame(t *testing.T) {
	cases := []struct {
		name, input string
		wantError   bool
	}{
		{"duplicate field", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"hello","body":"changed"}`, true},
		{"case alias", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","Body":"hello"}`, true},
		{"null optional field", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"hello","kind":null}`, true},
		{"nested duplicate field", `{"type":"subscribe_many","version":1,"subscriptions":[{"kind":"GROUP","chatId":"` + testID + `","chatId":"` + testID + `"}]}`, true},
		{"nested case alias", `{"type":"subscribe_many","version":1,"subscriptions":[{"Kind":"GROUP","chatId":"` + testID + `"}]}`, true},
		{"valid send", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"hello"}`, false},
		{"valid direct send", `{"type":"send","version":1,"recipientId":"` + testID + `","requestId":"` + testID + `","body":"hello"}`, false},
		{"valid group subscribe", `{"type":"subscribe","version":1,"kind":"GROUP","chatId":"` + testID + `"}`, false},
		{"lowercase group subscribe", `{"type":"subscribe","version":1,"kind":"group","chatId":"` + testID + `"}`, true},
		{"lowercase direct subscribe", `{"type":"subscribe","version":1,"kind":"direct","chatId":"` + testID + `"}`, true},
		{"valid direct subscribe", `{"type":"subscribe","version":1,"kind":"DIRECT","chatId":"` + testID + `"}`, false},
		{"valid subscribe batch", `{"type":"subscribe_many","version":1,"subscriptions":[{"kind":"GROUP","chatId":"` + testID + `"}]}`, false},
		{"empty subscribe batch", `{"type":"subscribe_many","version":1,"subscriptions":[]}`, true},
		{"duplicate subscribe batch", `{"type":"subscribe_many","version":1,"subscriptions":[{"kind":"GROUP","chatId":"` + testID + `"},{"kind":"GROUP","chatId":"` + testID + `"}]}`, true},
		{"unknown subscribe batch entry", `{"type":"subscribe_many","version":1,"subscriptions":[{"kind":"GROUP","chatId":"` + testID + `","extra":true}]}`, true},
		{"subscriptions on send", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"hello","subscriptions":[]}`, true},
		{"missing subscribe kind", `{"type":"subscribe","version":1,"chatId":"` + testID + `"}`, true},
		{"valid unsubscribe", `{"type":"unsubscribe","version":1,"chatId":"` + testID + `"}`, false},
		{"ambiguous target", `{"type":"send","version":1,"chatId":"` + testID + `","recipientId":"` + testID + `","requestId":"` + testID + `","body":"hello"}`, true},
		{"malformed recipient with chat", `{"type":"send","version":1,"chatId":"` + testID + `","recipientId":"bad","requestId":"` + testID + `","body":"hello"}`, true},
		{"malformed chat with recipient", `{"type":"send","version":1,"chatId":"bad","recipientId":"` + testID + `","requestId":"` + testID + `","body":"hello"}`, true},
		{"unknown field", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"hello","extra":1}`, true},
		{"trailing value", `{"type":"subscribe","version":1,"chatId":"` + testID + `"} {}`, true},
		{"missing body", `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `"}`, true},
		{"invalid ID", `{"type":"subscribe","version":1,"chatId":"lowercase"}`, true},
		{"unsupported version", `{"type":"subscribe","version":2,"chatId":"` + testID + `"}`, true},
		{"incomplete cursor", `{"type":"subscribe","version":1,"chatId":"` + testID + `","epoch":"e"}`, true},
		{"invalid sequence", `{"type":"applied","version":1,"chatId":"` + testID + `","sequence":4}`, true},
		{"valid dismissed", `{"type":"dismissed","version":1,"chatId":"` + testID + `","sequence":"9007199254740993"}`, false},
		{"zero dismissed", `{"type":"dismissed","version":1,"chatId":"` + testID + `","sequence":"0"}`, true},
		{"dismissed with Redis cursor", `{"type":"dismissed","version":1,"chatId":"` + testID + `","sequence":"2","epoch":"old"}`, true},
		{"valid received message", `{"type":"received_message","version":1,"chatId":"` + testID + `","sequence":"9007199254740993"}`, false},
		{"zero received message", `{"type":"received_message","version":1,"chatId":"` + testID + `","sequence":"0"}`, true},
		{"received message with Redis cursor", `{"type":"received_message","version":1,"chatId":"` + testID + `","sequence":"2","epoch":"old"}`, true},
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
	command := SendCommand{Version: 1, ChatID: testID, RequestID: testID, SenderID: testID, Body: "hello", SentAt: "2026-09-26T10:00:00Z"}
	raw, err := json.Marshal(command.Wire())
	if err != nil {
		t.Fatal(err)
	}
	var wire messaging.SendMessageCommandV1
	if err := json.Unmarshal(raw, &wire); err != nil {
		t.Fatal(err)
	}
	if wire.ChatId != command.ChatID || wire.RequestId != command.RequestID || wire.Body != command.Body {
		t.Fatalf("wire = %+v", wire)
	}
}

func TestDecodeFrameBodyCountsUnicodeCodePoints(t *testing.T) {
	input := `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"` + strings.Repeat("🙂", 4000) + `"}`
	if _, err := DecodeFrame([]byte(input)); err != nil {
		t.Fatalf("4000 code point body: %v", err)
	}
	input = `{"type":"send","version":1,"chatId":"` + testID + `","requestId":"` + testID + `","body":"` + strings.Repeat("🙂", 4001) + `"}`
	if _, err := DecodeFrame([]byte(input)); err == nil {
		t.Fatal("4001 code point body accepted")
	}
}

func TestDecodeEventRejectsMalformedOrUnknownPayload(t *testing.T) {
	valid := `{"type":"message_saved","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","chatId":"` + testID + `","requestId":"` + testID + `","messageId":"` + testID + `","sequence":"1","senderId":"` + testID + `","body":"hello","createdAt":"2026-09-26T10:00:00Z"}`
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
	raw := `{"type":"send_rejected","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","chatId":"` + testID + `","requestId":"` + testID + `","reason":"PROCESSING_FAILED"}`
	event, err := DecodeEvent([]byte(raw))
	if err != nil {
		t.Fatalf("DecodeEvent() error = %v", err)
	}
	if event.Reason != "PROCESSING_FAILED" {
		t.Fatalf("reason = %q, want PROCESSING_FAILED", event.Reason)
	}
}

func TestDecodeEventAcceptsChatCreationAndDirectRejection(t *testing.T) {
	created := `{"type":"chat_created","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","chatId":"` + testID + `"}`
	if _, err := DecodeEvent([]byte(created)); err != nil {
		t.Fatalf("chat creation: %v", err)
	}
	removed := `{"type":"member_removed","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","chatId":"` + testID + `","memberId":"` + testID + `"}`
	if _, err := DecodeEvent([]byte(removed)); err != nil {
		t.Fatalf("member removal: %v", err)
	}
	groupRemoved := `{"type":"member_removed","version":1,"eventId":"` + testID + `","room":"group:` + testID + `","chatId":"` + testID + `","memberId":"` + testID + `"}`
	if _, err := DecodeEvent([]byte(groupRemoved)); err != nil {
		t.Fatalf("group removal: %v", err)
	}
	wrongRoom := `{"type":"member_removed","version":1,"eventId":"` + testID + `","room":"group:01ARZ3NDEKTSV4RRFFQ69G5FAW","chatId":"` + testID + `","memberId":"` + testID + `"}`
	if _, err := DecodeEvent([]byte(wrongRoom)); err == nil {
		t.Fatal("member removal accepted a different group room")
	}
	rejected := `{"type":"send_rejected","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","recipientId":"` + testID + `","requestId":"` + testID + `","reason":"RECIPIENT_NOT_FOUND"}`
	if _, err := DecodeEvent([]byte(rejected)); err != nil {
		t.Fatalf("direct rejection: %v", err)
	}
}

func TestDecodeEventValidatesSessionRevocation(t *testing.T) {
	sessionID := strings.Repeat("a", 64)
	valid := `{"type":"session_revoked","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","sessionId":"` + sessionID + `"}`
	if _, err := DecodeEvent([]byte(valid)); err != nil {
		t.Fatalf("valid session revocation: %v", err)
	}
	for _, raw := range []string{
		strings.Replace(valid, `"sessionId":"`+sessionID+`"`, `"sessionId":""`, 1),
		strings.Replace(valid, `"room":"user:`, `"room":"group:`, 1),
		strings.Replace(valid, `"sessionId":"`+sessionID+`"`, `"sessionId":"`+sessionID+`","chatId":"`+testID+`"`, 1),
	} {
		if _, err := DecodeEvent([]byte(raw)); err == nil {
			t.Fatalf("accepted invalid session revocation: %s", raw)
		}
	}
}

func TestDecodeEventRejectsConflictingRejectionTargets(t *testing.T) {
	for _, targets := range []string{
		`"chatId":"bad","recipientId":"` + testID + `"`,
		`"chatId":"` + testID + `","recipientId":"bad"`,
	} {
		raw := `{"type":"send_rejected","version":1,"eventId":"` + testID + `","room":"user:` + testID + `","requestId":"` + testID + `","reason":"RECIPIENT_NOT_FOUND",` + targets + `}`
		if _, err := DecodeEvent([]byte(raw)); err == nil {
			t.Fatalf("accepted conflicting rejection targets: %s", raw)
		}
	}
}

func TestDecodeMembershipChanged(t *testing.T) {
	payload, err := os.ReadFile("../../../contracts/fixtures/valid/membership-changed.json")
	if err != nil {
		t.Fatal(err)
	}
	event, err := DecodeEvent(payload)
	if err != nil || event.Type != EventMembershipChanged || event.Room != "group:"+event.ChatID {
		t.Fatalf("membership notification = %+v, error = %v", event, err)
	}
	var fields map[string]any
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	for name, value := range map[string]any{
		"room":   "group:01ARZ3NDEKTSV4RRFFQ69G5FAW",
		"chatId": "invalid", "eventId": nil, "version": 2,
		"sequence": "", "requestId": "", "memberId": "", "sessionId": "",
		"epoch": "epoch", "streamId": "1-0", "unknown": true,
	} {
		t.Run(name, func(t *testing.T) {
			invalid := make(map[string]any)
			for key, original := range fields {
				invalid[key] = original
			}
			invalid[name] = value
			wire, err := json.Marshal(invalid)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := DecodeEvent(wire); err == nil {
				t.Fatalf("accepted %s", wire)
			}
		})
	}
	for _, field := range []string{"version", "eventId", "room", "chatId"} {
		invalid := make(map[string]any)
		for key, value := range fields {
			if key != field {
				invalid[key] = value
			}
		}
		wire, _ := json.Marshal(invalid)
		if _, err := DecodeEvent(wire); err == nil {
			t.Fatalf("accepted missing %s", field)
		}
	}
	event.Room = "user:" + event.ChatID
	if err := ValidateEvent(event); err == nil {
		t.Fatal("accepted user room")
	}
}
