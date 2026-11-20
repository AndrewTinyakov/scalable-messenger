package protocol

import (
	"encoding/json"
	"os"
	"testing"

	"messenger/ws/internal/messagecodec"
)

const otherID = "01ARZ3NDEKTSV4RRFFQ69G5FAW"

func TestForwardSendCarriesSourceIntoGeneratedCommand(t *testing.T) {
	base := map[string]any{"type": "send", "version": 1, "chatId": testID, "requestId": testID, "body": "copy", "forwardFromChatId": otherID, "forwardFromMessageId": otherID}
	frame, err := DecodeFrame(featureJSON(t, base))
	if err != nil || frame.ForwardFromChatID != otherID || frame.ForwardFromMsgID != otherID {
		t.Fatalf("forward send = %+v, %v", frame, err)
	}
	wire := SendCommand{Version: 1, ChatID: testID, RequestID: testID, SenderID: testID, Body: "copy", SentAt: "2026-11-05T09:00:00Z", ForwardChatID: frame.ForwardFromChatID, ForwardMessageID: frame.ForwardFromMsgID}.Wire()
	if wire.ForwardFromChatId != otherID || wire.ForwardFromMessageId != otherID {
		t.Fatalf("generated command lost forward source: %+v", wire)
	}
	for name, mutate := range map[string]func(map[string]any){
		"missing message":  func(f map[string]any) { delete(f, "forwardFromMessageId") },
		"missing chat":     func(f map[string]any) { delete(f, "forwardFromChatId") },
		"invalid source":   func(f map[string]any) { f["forwardFromMessageId"] = "invalid" },
		"direct draft":     func(f map[string]any) { delete(f, "chatId"); f["recipientId"] = testID },
		"reply and fwd":    func(f map[string]any) { f["replyToMessageId"] = otherID },
		"non-send frame":   func(f map[string]any) { f["type"] = "unsubscribe"; delete(f, "body"); delete(f, "requestId") },
		"empty identifier": func(f map[string]any) { f["forwardFromChatId"] = "" },
	} {
		t.Run(name, func(t *testing.T) {
			fields := map[string]any{}
			for key, value := range base {
				fields[key] = value
			}
			mutate(fields)
			if _, err := DecodeFrame(featureJSON(t, fields)); err == nil {
				t.Fatal("invalid forward frame accepted")
			}
		})
	}
}

func TestForwardCommandFixtureMatchesGeneratedWire(t *testing.T) {
	payload, err := os.ReadFile("../../../contracts/fixtures/valid/send-forward-command.json")
	if err != nil {
		t.Fatal(err)
	}
	command, err := messagecodec.Decode[SendCommand](payload)
	if err != nil {
		t.Fatal(err)
	}
	wire, err := json.Marshal(command.Wire())
	if err != nil {
		t.Fatal(err)
	}
	featureAssertJSONEqual(t, wire, payload)
}

func TestPersonalChatEventsStayInAuthorizedRooms(t *testing.T) {
	user := map[string]any{"type": "chat_preferences_changed", "version": 1, "eventId": testID, "room": "user:" + otherID, "chatId": testID, "memberSeq": "3"}
	if _, err := DecodeEvent(featureJSON(t, user)); err != nil {
		t.Fatalf("preference event rejected: %v", err)
	}
	pins := map[string]any{"type": "pins_changed", "version": 1, "eventId": testID, "room": "group:" + testID, "chatId": testID, "seq": "4"}
	if _, err := DecodeEvent(featureJSON(t, pins)); err != nil {
		t.Fatalf("group pin event rejected: %v", err)
	}
	personalPins := map[string]any{"type": "pins_changed", "version": 1, "eventId": testID, "room": "user:" + otherID, "chatId": testID, "memberSeq": "4"}
	if _, err := DecodeEvent(featureJSON(t, personalPins)); err != nil {
		t.Fatalf("personal pin event rejected: %v", err)
	}
	for name, fields := range map[string]map[string]any{
		"preferences in group room": {"type": "chat_preferences_changed", "version": 1, "eventId": testID, "room": "group:" + testID, "chatId": testID},
		"pins in another group":     {"type": "pins_changed", "version": 1, "eventId": testID, "room": "group:" + otherID, "chatId": testID},
		"pins with body":            {"type": "pins_changed", "version": 1, "eventId": testID, "room": "user:" + testID, "chatId": testID, "body": "leak"},
		"preferences without chat":  {"type": "chat_preferences_changed", "version": 1, "eventId": testID, "room": "user:" + testID, "memberSeq": "1"},
		"preferences without count": {"type": "chat_preferences_changed", "version": 1, "eventId": testID, "room": "user:" + testID, "chatId": testID},
		"preferences with chat seq": {"type": "chat_preferences_changed", "version": 1, "eventId": testID, "room": "user:" + testID, "chatId": testID, "seq": "1"},
		"pins with both counters":   {"type": "pins_changed", "version": 1, "eventId": testID, "room": "user:" + testID, "chatId": testID, "seq": "1", "memberSeq": "1"},
		"member pins in group room": {"type": "pins_changed", "version": 1, "eventId": testID, "room": "group:" + testID, "chatId": testID, "memberSeq": "1"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
				t.Fatal("invalid personal chat event accepted")
			}
		})
	}
}

func TestForwardedAuthorOnlyAppearsOnSavedMessages(t *testing.T) {
	saved := featureSaved()
	saved["forwardedFromUserId"] = otherID
	event, err := DecodeEvent(featureJSON(t, saved))
	if err != nil || event.ForwardedFromUserID != otherID {
		t.Fatalf("forwarded save = %+v, %v", event, err)
	}
	saved["forwardedFromUserId"] = "invalid"
	if _, err := DecodeEvent(featureJSON(t, saved)); err == nil {
		t.Fatal("invalid forwarded author accepted")
	}
	changed := featureChanged()
	changed["forwardedFromUserId"] = otherID
	if _, err := DecodeEvent(featureJSON(t, changed)); err == nil {
		t.Fatal("forwarded author accepted outside message_saved")
	}
}
