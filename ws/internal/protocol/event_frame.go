package protocol

import "encoding/json"

type EventFrame struct {
	event   Event
	payload []byte
}

func NewEventFrame(event Event) (*EventFrame, error) {
	if event.Version == 0 {
		event.Version = 1
	}
	payload, err := json.Marshal(event)
	if err != nil {
		return nil, err
	}
	return &EventFrame{event: event, payload: payload}, nil
}

func (frame *EventFrame) Event() Event { return frame.event }

func (frame *EventFrame) Payload() []byte { return frame.payload }

func (frame *EventFrame) Size() int { return len(frame.payload) }
