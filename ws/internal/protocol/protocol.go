package protocol

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"regexp"
	"strings"
	"time"

	"messenger/ws/internal/generated/messaging"
)

var ulidPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

type Frame struct {
	Type                string `json:"type"`
	Version             int    `json:"version"`
	ConversationID      string `json:"conversationId,omitempty"`
	RequestID           string `json:"requestId,omitempty"`
	Body                string `json:"body,omitempty"`
	Sequence            string `json:"sequence,omitempty"`
	Epoch               string `json:"epoch,omitempty"`
	StreamID            string `json:"streamId,omitempty"`
	LastAppliedSequence string `json:"lastAppliedSequence,omitempty"`
}

type Event struct {
	Type           string `json:"type"`
	Version        int    `json:"version,omitempty"`
	EventID        string `json:"eventId,omitempty"`
	Room           string `json:"room,omitempty"`
	ConversationID string `json:"conversationId,omitempty"`
	RequestID      string `json:"requestId,omitempty"`
	MessageID      string `json:"messageId,omitempty"`
	Sequence       string `json:"sequence,omitempty"`
	SenderID       string `json:"senderId,omitempty"`
	Body           string `json:"body,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	Reason         string `json:"reason,omitempty"`
	Epoch          string `json:"epoch,omitempty"`
	StreamID       string `json:"streamId,omitempty"`
	Code           string `json:"code,omitempty"`
}

type SendCommand struct {
	Version        int    `json:"version"`
	ConversationID string `json:"conversationId"`
	RequestID      string `json:"requestId"`
	SenderID       string `json:"senderId"`
	Body           string `json:"body"`
	SentAt         string `json:"sentAt"`
}

func (command SendCommand) Wire() messaging.SendMessageCommandV1 {
	return messaging.SendMessageCommandV1{Version: command.Version, ConversationId: command.ConversationID, RequestId: command.RequestID, SenderId: command.SenderID, Body: command.Body, SentAt: command.SentAt}
}

func DecodeFrame(data []byte) (Frame, error) {
	var f Frame
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&f); err != nil {
		return f, err
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return f, errors.New("multiple JSON values")
	}
	if f.Version != 1 {
		return f, errors.New("unsupported frame version")
	}
	switch f.Type {
	case "send":
		if !ValidULID(f.ConversationID) || !ValidULID(f.RequestID) || strings.TrimSpace(f.Body) == "" || len([]rune(f.Body)) > 4000 || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid send")
		}
	case "subscribe":
		if !ValidULID(f.ConversationID) {
			return f, errors.New("invalid conversation ID")
		}
		if f.RequestID != "" || f.Body != "" || f.Sequence != "" {
			return f, errors.New("invalid subscribe")
		}
		if f.LastAppliedSequence != "" && !validSequence(f.LastAppliedSequence) {
			return f, errors.New("invalid last applied sequence")
		}
		if (f.Epoch == "") != (f.StreamID == "") {
			return f, errors.New("incomplete Redis cursor")
		}
	case "applied":
		if !ValidULID(f.ConversationID) || !validSequence(f.Sequence) {
			return f, errors.New("invalid applied position")
		}
		if f.RequestID != "" || f.Body != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid applied frame")
		}
		if (f.Epoch == "") != (f.StreamID == "") {
			return f, errors.New("incomplete Redis cursor")
		}
	default:
		return f, errors.New("unknown frame type")
	}
	return f, nil
}

func DecodeEvent(data []byte) (Event, error) {
	var event Event
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&event); err != nil {
		return event, err
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return event, errors.New("multiple event values")
	}
	if event.Version != 1 || !ValidULID(event.EventID) || !ValidULID(event.ConversationID) || !ValidULID(event.RequestID) || !validRoom(event.Room) || event.Epoch != "" || event.StreamID != "" || event.Code != "" {
		return event, errors.New("invalid event metadata")
	}
	switch event.Type {
	case "message_saved":
		if !ValidULID(event.MessageID) || !ValidULID(event.SenderID) || !validSequence(event.Sequence) || event.Sequence == "0" || event.Body == "" || len([]rune(event.Body)) > 4000 || event.Reason != "" {
			return event, errors.New("invalid saved event")
		}
		if _, err := time.Parse(time.RFC3339Nano, event.CreatedAt); err != nil {
			return event, errors.New("invalid event timestamp")
		}
	case "send_rejected":
		if event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" {
			return event, errors.New("invalid rejection event")
		}
		switch event.Reason {
		case "NOT_A_MEMBER", "CONVERSATION_NOT_FOUND", "EMPTY_BODY", "BODY_TOO_LONG", "REQUEST_ID_CONFLICT", "PROCESSING_FAILED":
		default:
			return event, errors.New("invalid rejection reason")
		}
	default:
		return event, errors.New("unknown event type")
	}
	return event, nil
}

func validRoom(room string) bool {
	parts := strings.SplitN(room, ":", 2)
	return len(parts) == 2 && (parts[0] == "user" || parts[0] == "group") && ValidULID(parts[1])
}

func ValidULID(s string) bool { return ulidPattern.MatchString(s) }
func validSequence(s string) bool {
	if s == "" {
		return false
	}
	if len(s) > 1 && s[0] == '0' {
		return false
	}
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}
