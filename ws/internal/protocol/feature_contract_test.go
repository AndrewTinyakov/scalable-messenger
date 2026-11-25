package protocol

import (
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"

	"messenger/ws/internal/messagecodec"
)

func featureJSON(t *testing.T, fields map[string]any) []byte {
	t.Helper()
	payload, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	return payload
}

func featureSaved() map[string]any {
	return map[string]any{"type": "message_saved", "version": 1, "eventId": testID, "room": "user:" + testID, "chatId": testID, "requestId": testID, "messageId": testID, "sequence": "9007199254740993", "senderId": testID, "body": "hello", "createdAt": "2026-09-26T09:00:01Z"}
}

func featureChanged() map[string]any {
	fields := featureSaved()
	fields["type"] = "message_changed"
	delete(fields, "requestId")
	fields["messageVersion"] = "2"
	fields["seq"] = "9007199254740993"
	fields["editedAt"] = "2026-09-27T09:00:01Z"
	return fields
}

func featureReply(fields map[string]any) {
	fields["replyToMessageId"] = testID
	fields["replySenderId"] = testID
	fields["replyBody"] = "quoted text"
	fields["replyDeleted"] = false
	fields["replyVersion"] = "9007199254740993"
}

func TestFeatureSendReplyRequiresExistingChatAndValidTarget(t *testing.T) {
	base := map[string]any{"type": "send", "version": 1, "chatId": testID, "requestId": testID, "body": "reply", "replyToMessageId": testID}
	frame, err := DecodeFrame(featureJSON(t, base))
	if err != nil || frame.ReplyToMessageID != testID {
		t.Fatalf("reply send = %+v, %v", frame, err)
	}
	command := SendCommand{Version: 1, ChatID: testID, RequestID: testID, SenderID: testID, Body: "reply", SentAt: "2026-09-26T09:00:01Z", ReplyToMessageID: frame.ReplyToMessageID}
	wire := command.Wire()
	if wire.ReplyToMessageId != testID {
		t.Fatal("generated send command lost reply reference")
	}
	for _, mutate := range []func(map[string]any){
		func(f map[string]any) { delete(f, "chatId"); f["recipientId"] = testID },
		func(f map[string]any) { f["replyToMessageId"] = "invalid" },
		func(f map[string]any) { f["replyToMessageId"] = nil },
		func(f map[string]any) { f["type"] = "unsubscribe"; delete(f, "body"); delete(f, "requestId") },
	} {
		fields := map[string]any{}
		for k, v := range base {
			fields[k] = v
		}
		mutate(fields)
		if _, err := DecodeFrame(featureJSON(t, fields)); err == nil {
			t.Fatalf("accepted invalid reply frame %s", featureJSON(t, fields))
		}
	}
}

func TestFeaturePresenceWatchStrictShapeAndBounds(t *testing.T) {
	base := func() map[string]any {
		return map[string]any{"type": "watch_presence", "version": 1, "reset": true, "add": []string{testID}, "remove": []string{}}
	}
	if _, err := DecodeFrame(featureJSON(t, base())); err != nil {
		t.Fatal(err)
	}
	if _, err := DecodeFrame([]byte(`{"type":"watch_presence","version":1}`)); err != nil {
		t.Fatal(err)
	}
	ids := make([]string, 500)
	for i := range ids {
		ids[i] = fmt.Sprintf("%026d", i+1)
	}
	fields := base()
	fields["add"] = ids
	if frame, err := DecodeFrame(featureJSON(t, fields)); err != nil || len(frame.Add) != 500 || !frame.Reset {
		t.Fatalf("maximum presence watch = %+v, %v", frame, err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"oversize", func(f map[string]any) { f["add"] = append(ids, testID) }},
		{"duplicate", func(f map[string]any) { f["remove"] = []string{testID, testID} }},
		{"invalid peer", func(f map[string]any) { f["add"] = []string{"invalid"} }},
		{"null peer", func(f map[string]any) { f["add"] = []any{nil} }},
		{"unknown field", func(f map[string]any) { f["online"] = true }},
		{"chat identity", func(f map[string]any) { f["chatId"] = testID }},
		{"foreign send", func(f map[string]any) { f["body"] = "hello" }},
		{"wrong version", func(f map[string]any) { f["version"] = 2 }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fields := base()
			tc.mutate(fields)
			if _, err := DecodeFrame(featureJSON(t, fields)); err == nil {
				t.Fatalf("accepted invalid watch %s", featureJSON(t, fields))
			}
		})
	}
	for _, payload := range []string{`{"type":"activity","version":1,"active":true,"visible":false}`, `{"type":"watch_online_count","version":1}`, `{"type":"watch_online_count","version":1,"chatId":"` + testID + `"}`} {
		if _, err := DecodeFrame([]byte(payload)); err != nil {
			t.Fatalf("rejected %s: %v", payload, err)
		}
	}
	for _, payload := range []string{`{"type":"activity","version":1,"active":true}`, `{"type":"watch_online_count","version":1,"chatId":"invalid"}`, `{"type":"unwatch_presence","version":1}`} {
		if _, err := DecodeFrame([]byte(payload)); err == nil {
			t.Fatalf("accepted %s", payload)
		}
	}
	for _, kind := range []string{"subscribe", "unsubscribe", "send"} {
		fields := map[string]any{"type": kind, "version": 1, "chatId": testID, "add": []string{testID}}
		if kind == "subscribe" {
			fields["kind"] = "GROUP"
		}
		if kind == "send" {
			fields["requestId"] = testID
			fields["body"] = "hello"
		}
		if _, err := DecodeFrame(featureJSON(t, fields)); err == nil {
			t.Fatalf("accepted presence targets on %s", kind)
		}
	}
}

func TestFeatureMessageVersionAndReplyPreviewContracts(t *testing.T) {
	original := featureSaved()
	if event, err := DecodeEvent(featureJSON(t, original)); err != nil || event.Type != EventMessageSaved || event.Sequence != "9007199254740993" {
		t.Fatalf("legacy saved event = %+v, %v", event, err)
	}
	fields := featureSaved()
	fields["messageVersion"] = "9007199254740993"
	featureReply(fields)
	event, err := DecodeEvent(featureJSON(t, fields))
	if err != nil || event.MessageVersion != "9007199254740993" || event.ReplyDeleted == nil || *event.ReplyDeleted || event.ReplyVersion != "9007199254740993" {
		t.Fatalf("versioned reply = %+v, %v", event, err)
	}
	frame, err := NewEventFrame(event)
	if err != nil || !strings.Contains(string(frame.Payload()), `"replyDeleted":false`) {
		t.Fatalf("reply false flag lost: %s, %v", frame.Payload(), err)
	}
	for _, field := range []string{"replyToMessageId", "replySenderId", "replyBody", "replyDeleted", "replyVersion"} {
		t.Run("missing "+field, func(t *testing.T) {
			fields := featureSaved()
			featureReply(fields)
			delete(fields, field)
			if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
				t.Fatalf("accepted incomplete reply without %s", field)
			}
		})
	}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"zero message version", func(f map[string]any) { f["messageVersion"] = "0" }},
		{"padded message version", func(f map[string]any) { f["messageVersion"] = "02" }},
		{"numeric message version", func(f map[string]any) { f["messageVersion"] = 2 }},
		{"overflow message version", func(f map[string]any) { f["messageVersion"] = "9223372036854775808" }},
		{"null message version", func(f map[string]any) { f["messageVersion"] = nil }},
		{"zero reply version", func(f map[string]any) { f["replyVersion"] = "0" }},
		{"long Unicode preview", func(f map[string]any) { f["replyBody"] = strings.Repeat("🦊", 161) }},
		{"deleted preview leaks body", func(f map[string]any) { f["replyDeleted"] = true }},
		{"live preview empty", func(f map[string]any) { f["replyBody"] = "" }},
		{"unknown reply property", func(f map[string]any) { f["replyUnknown"] = true }},
		{"presence on saved", func(f map[string]any) { f["statuses"] = []any{} }},
		{"chat sequence on saved", func(f map[string]any) { f["seq"] = "1" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fields := featureSaved()
			featureReply(fields)
			tc.mutate(fields)
			if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
				t.Fatalf("accepted malformed saved event %s", featureJSON(t, fields))
			}
		})
	}
	fields = featureSaved()
	featureReply(fields)
	fields["replyBody"] = strings.Repeat("🦊", 160)
	if _, err := DecodeEvent(featureJSON(t, fields)); err != nil {
		t.Fatalf("160 codepoint preview rejected: %v", err)
	}
}

func TestFeatureTombstoneWireRetainsEmptyBodyAndDeletedQuote(t *testing.T) {
	fields := featureChanged()
	fields["body"] = ""
	fields["deletedAt"] = "2026-09-27T10:00:01Z"
	featureReply(fields)
	fields["replyDeleted"] = true
	fields["replyBody"] = ""
	event, err := DecodeEvent(featureJSON(t, fields))
	if err != nil {
		t.Fatal(err)
	}
	frame, err := NewEventFrame(event)
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]json.RawMessage
	if err := json.Unmarshal(frame.Payload(), &wire); err != nil {
		t.Fatal(err)
	}
	if string(wire["body"]) != `""` || string(wire["replyBody"]) != `""` || string(wire["replyDeleted"]) != "true" {
		t.Fatalf("tombstone wire = %s", frame.Payload())
	}
	decoded, err := DecodeEvent(frame.Payload())
	if err != nil || !reflect.DeepEqual(decoded, event) {
		t.Fatalf("tombstone roundtrip = %+v, %v", decoded, err)
	}
	for _, tc := range []struct {
		name   string
		mutate func(map[string]any)
	}{
		{"deleted body leaks", func(f map[string]any) { f["body"] = "old secret" }},
		{"empty live body", func(f map[string]any) { delete(f, "deletedAt") }},
		{"missing version", func(f map[string]any) { delete(f, "messageVersion") }},
		{"missing chat sequence", func(f map[string]any) { delete(f, "seq") }},
		{"zero chat sequence", func(f map[string]any) { f["seq"] = "0" }},
		{"member sequence", func(f map[string]any) { f["memberSeq"] = "1" }},
		{"malformed deleted time", func(f map[string]any) { f["deletedAt"] = "yesterday" }},
		{"foreign request", func(f map[string]any) { f["requestId"] = testID }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			copy := map[string]any{}
			for k, v := range fields {
				copy[k] = v
			}
			tc.mutate(copy)
			if _, err := DecodeEvent(featureJSON(t, copy)); err == nil {
				t.Fatalf("accepted malformed tombstone %s", featureJSON(t, copy))
			}
		})
	}
}

func TestFeatureChatInvalidationsContainOnlyDurableMetadata(t *testing.T) {
	for _, kind := range []string{"chat_deleted", "reads_changed"} {
		t.Run(kind, func(t *testing.T) {
			base := func() map[string]any {
				fields := map[string]any{"type": kind, "version": 1, "eventId": testID, "room": "group:" + testID, "chatId": testID}
				if kind == "chat_deleted" {
					fields["seq"] = "7"
				}
				return fields
			}
			if event, err := DecodeEvent(featureJSON(t, base())); err != nil || string(event.Type) != kind {
				t.Fatalf("invalidation = %+v, %v", event, err)
			}
			for _, field := range []string{"messageVersion", "mutationRevision", "memberSeq", "userSeq", "replyToMessageId", "observedAt", "body", "requestId", "sessionId", "unknown"} {
				fields := base()
				fields[field] = "1"
				if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
					t.Fatalf("%s accepted foreign field %s", kind, field)
				}
			}
			fields := base()
			fields["chatId"] = nil
			if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
				t.Fatal("accepted null chat")
			}
		})
	}
}

func TestFeatureSharedLegacySavedFixtureStillDecodes(t *testing.T) {
	payload, err := os.ReadFile("../../../contracts/fixtures/valid/message-saved.json")
	if err != nil {
		t.Fatal(err)
	}
	event, err := DecodeEvent(payload)
	if err != nil || event.Sequence != "9007199254740993" || event.Type != EventMessageSaved {
		t.Fatalf("shared legacy fixture = %+v, %v", event, err)
	}
}

func TestFeatureOptionalValuesCannotUseEmptyStringToBypassShapeValidation(t *testing.T) {
	for _, tc := range []struct {
		name   string
		fields map[string]any
	}{
		{"empty saved message version", func() map[string]any { f := featureSaved(); f["messageVersion"] = ""; return f }()},
		{"empty saved reply target", func() map[string]any { f := featureSaved(); f["replyToMessageId"] = ""; return f }()},
		{"orphan empty quote body", func() map[string]any { f := featureSaved(); f["replyBody"] = ""; return f }()},
		{"empty foreign message metadata", map[string]any{"type": "chat_deleted", "version": 1, "eventId": testID, "room": "group:" + testID, "chatId": testID, "messageVersion": ""}},
		{"empty foreign presence metadata", func() map[string]any { f := featureSaved(); f["unavailable"] = []string{}; return f }()},
		{"missing tombstone body", func() map[string]any {
			f := featureChanged()
			delete(f, "body")
			f["deletedAt"] = "2026-09-27T10:00:01Z"
			return f
		}()},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeEvent(featureJSON(t, tc.fields)); err == nil {
				t.Fatalf("accepted invalid event shape %s", featureJSON(t, tc.fields))
			}
		})
	}
	for _, tc := range []struct {
		name   string
		fields map[string]any
	}{
		{"empty reply target", map[string]any{"type": "send", "version": 1, "chatId": testID, "requestId": testID, "body": "hello", "replyToMessageId": ""}},
		{"empty foreign reply target", map[string]any{"type": "watch_presence", "version": 1, "replyToMessageId": ""}},
		{"empty foreign watch body", map[string]any{"type": "watch_presence", "version": 1, "add": []string{testID}, "body": ""}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if _, err := DecodeFrame(featureJSON(t, tc.fields)); err == nil {
				t.Fatalf("accepted invalid frame shape %s", featureJSON(t, tc.fields))
			}
		})
	}
}

func featureAssertJSONEqual(t *testing.T, actual, expected []byte) {
	t.Helper()
	var got, want any
	if err := json.Unmarshal(actual, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("wire roundtrip mismatch: got %s, want %s", actual, expected)
	}
}

func TestFeatureSharedDurableFixturesRoundTripWithoutLosingTombstonesOrReplyFlags(t *testing.T) {
	for _, name := range []string{"message-saved-reply", "message-changed", "message-deleted", "message-saved-deleted-reply", "chat-deleted", "reads-changed", "history-changed", "message-saved-reply-identity", "chat-preferences-changed", "pins-changed", "message-saved-forward"} {
		t.Run(name, func(t *testing.T) {
			payload, err := os.ReadFile("../../../contracts/fixtures/valid/" + name + ".json")
			if err != nil {
				t.Fatal(err)
			}
			event, err := DecodeEvent(payload)
			if err != nil {
				t.Fatal(err)
			}
			frame, err := NewEventFrame(event)
			if err != nil {
				t.Fatal(err)
			}
			featureAssertJSONEqual(t, frame.Payload(), payload)
		})
	}
}

func TestFeatureSharedPresenceFixturesMatchGatewayWire(t *testing.T) {
	for _, name := range []string{"socket-presence", "online-count", "presence-config"} {
		payload, err := os.ReadFile("../../../contracts/fixtures/valid/" + name + ".json")
		if err != nil {
			t.Fatal(err)
		}
		event, err := messagecodec.Decode[Event](payload)
		if err != nil {
			t.Fatal(err)
		}
		frame, err := NewEventFrame(event)
		if err != nil {
			t.Fatal(err)
		}
		featureAssertJSONEqual(t, frame.Payload(), payload)
		if _, err := DecodeEvent(payload); err == nil {
			t.Fatalf("gateway-only %s was accepted as a durable room event", name)
		}
	}
	frame, err := NewEventFrame(Event{Type: EventOnlineCount, Version: 1, ChatID: testID, Members: 2})
	if err != nil || !strings.Contains(string(frame.Payload()), `"online":0`) {
		t.Fatalf("zero online count = %s, %v", frame.Payload(), err)
	}
}

func TestFeatureSharedReplyCommandMatchesGeneratedWire(t *testing.T) {
	payload, err := os.ReadFile("../../../contracts/fixtures/valid/send-reply-command.json")
	if err != nil {
		t.Fatal(err)
	}
	command, err := messagecodec.Decode[SendCommand](payload)
	if err != nil {
		t.Fatal(err)
	}
	if command.ReplyToMessageID != "01ARZ3NDEKTSV4RRFFQ69G5FAW" {
		t.Fatalf("shared reply target = %q", command.ReplyToMessageID)
	}
	wire, err := json.Marshal(command.Wire())
	if err != nil {
		t.Fatal(err)
	}
	featureAssertJSONEqual(t, wire, payload)
}

func TestHistoryHintsRejectContentAndInvalidSequences(t *testing.T) {
	payload, err := os.ReadFile("../../../contracts/fixtures/valid/history-changed.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []any{nil, 1, "0", "-1", "01", "9223372036854775808"} {
		fields := map[string]any{}
		if err := json.Unmarshal(payload, &fields); err != nil {
			t.Fatal(err)
		}
		fields["seq"] = value
		if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
			t.Fatalf("accepted invalid sequence %v", value)
		}
	}
	fields := map[string]any{}
	if err := json.Unmarshal(payload, &fields); err != nil {
		t.Fatal(err)
	}
	fields["body"] = "removed text"
	if _, err := DecodeEvent(featureJSON(t, fields)); err == nil {
		t.Fatal("accepted body in history hint")
	}
}
