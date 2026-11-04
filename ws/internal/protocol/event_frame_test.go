package protocol

import "testing"

func TestEventFramePreservesWireEventAndCursor(t *testing.T) {
	event := Event{Type: EventMessageSaved, ChatID: "chat", Sequence: "9007199254740993", Body: "hello", Epoch: "epoch", StreamID: "2-0"}
	frame, err := NewEventFrame(event)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"message_saved","version":1,"chatId":"chat","sequence":"9007199254740993","body":"hello","epoch":"epoch","streamId":"2-0"}`
	if string(frame.Payload()) != want || frame.Size() != len(want) {
		t.Fatalf("frame payload = %s, size = %d", frame.Payload(), frame.Size())
	}
	event.Body = "changed"
	copy := frame.Event()
	copy.Sequence = "1"
	if got := frame.Event(); got.Body != "hello" || got.Sequence != "9007199254740993" || got.Version != 1 {
		t.Fatalf("frame event changed: %+v", got)
	}
}

func TestMembershipChangedFrameCarriesOnlyMetadataAndCursor(t *testing.T) {
	event := Event{Type: EventMembershipChanged, EventID: testID, ChatID: testID, Room: "group:" + testID, Epoch: "epoch", StreamID: "2-0"}
	frame, err := NewEventFrame(event)
	if err != nil {
		t.Fatal(err)
	}
	want := `{"type":"membership_changed","version":1,"eventId":"` + testID + `","room":"group:` + testID + `","chatId":"` + testID + `","epoch":"epoch","streamId":"2-0"}`
	if string(frame.Payload()) != want {
		t.Fatalf("frame payload = %s", frame.Payload())
	}
}
