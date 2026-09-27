package protocol

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"messenger/ws/internal/generated/messaging"
	"messenger/ws/internal/messagecodec"
	"messenger/ws/internal/ticket"
)

var ulidPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

type Frame struct {
	Type                string         `json:"type"`
	Version             int            `json:"version"`
	ChatID              string         `json:"chatId,omitempty"`
	Kind                string         `json:"kind,omitempty"`
	RecipientID         string         `json:"recipientId,omitempty"`
	RequestID           string         `json:"requestId,omitempty"`
	Body                string         `json:"body,omitempty"`
	Sequence            string         `json:"sequence,omitempty"`
	Epoch               string         `json:"epoch,omitempty"`
	StreamID            string         `json:"streamId,omitempty"`
	LastAppliedSequence string         `json:"lastAppliedSequence,omitempty"`
	Subscriptions       []Subscription `json:"subscriptions,omitempty"`
}

type Subscription struct {
	ChatID              string `json:"chatId"`
	Kind                string `json:"kind"`
	Epoch               string `json:"epoch,omitempty"`
	StreamID            string `json:"streamId,omitempty"`
	LastAppliedSequence string `json:"lastAppliedSequence,omitempty"`
}

type Event struct {
	Type        string `json:"type"`
	Version     int    `json:"version,omitempty"`
	EventID     string `json:"eventId,omitempty"`
	Room        string `json:"room,omitempty"`
	SessionID   string `json:"sessionId,omitempty"`
	ChatID      string `json:"chatId,omitempty"`
	RecipientID string `json:"recipientId,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	MessageID   string `json:"messageId,omitempty"`
	Sequence    string `json:"sequence,omitempty"`
	SenderID    string `json:"senderId,omitempty"`
	Body        string `json:"body,omitempty"`
	CreatedAt   string `json:"createdAt,omitempty"`
	Reason      string `json:"reason,omitempty"`
	Epoch       string `json:"epoch,omitempty"`
	StreamID    string `json:"streamId,omitempty"`
	Code        string `json:"code,omitempty"`
}

type SendCommand struct {
	Version     int    `json:"version"`
	ChatID      string `json:"chatId"`
	RecipientID string `json:"recipientId,omitempty"`
	RequestID   string `json:"requestId"`
	SenderID    string `json:"senderId"`
	Body        string `json:"body"`
	SentAt      string `json:"sentAt"`
}

func (command SendCommand) Wire() messaging.SendMessageCommandV1 {
	return messaging.SendMessageCommandV1{Version: command.Version, ChatId: command.ChatID, RecipientId: command.RecipientID, RequestId: command.RequestID, SenderId: command.SenderID, Body: command.Body, SentAt: command.SentAt}
}

func DecodeFrame(data []byte) (Frame, error) {
	f, err := messagecodec.Decode[Frame](data)
	if err != nil {
		return f, err
	}
	if f.Version != 1 {
		return f, errors.New("unsupported frame version")
	}
	if f.Type != "subscribe_many" && f.Subscriptions != nil {
		return f, errors.New("unexpected subscriptions")
	}
	switch f.Type {
	case "send":
		if (f.ChatID == "") == (f.RecipientID == "") ||
			(f.ChatID != "" && !ValidULID(f.ChatID)) ||
			(f.RecipientID != "" && !ValidULID(f.RecipientID)) ||
			!ValidULID(f.RequestID) || strings.TrimSpace(f.Body) == "" || len([]rune(f.Body)) > 4000 || f.Kind != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid send")
		}
	case "subscribe":
		if f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" {
			return f, errors.New("invalid subscribe")
		}
		if !validSubscription(Subscription{f.ChatID, f.Kind, f.Epoch, f.StreamID, f.LastAppliedSequence}) {
			return f, errors.New("invalid subscribe")
		}
	case "subscribe_many":
		if f.ChatID != "" || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" || len(f.Subscriptions) < 1 || len(f.Subscriptions) > 10 {
			return f, errors.New("invalid subscribe batch")
		}
		seen := make(map[string]struct{}, len(f.Subscriptions))
		for _, subscription := range f.Subscriptions {
			if !validSubscription(subscription) {
				return f, errors.New("invalid subscribe batch entry")
			}
			if _, exists := seen[subscription.ChatID]; exists {
				return f, errors.New("duplicate chat in subscribe batch")
			}
			seen[subscription.ChatID] = struct{}{}
		}
	case "unsubscribe":
		if !ValidULID(f.ChatID) || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Sequence != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid unsubscribe")
		}
	case "applied":
		if !ValidULID(f.ChatID) || !validSequence(f.Sequence) {
			return f, errors.New("invalid applied position")
		}
		if f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid applied frame")
		}
		if (f.Epoch == "") != (f.StreamID == "") {
			return f, errors.New("incomplete Redis cursor")
		}
	case "dismissed":
		if !ValidULID(f.ChatID) || !validSequence(f.Sequence) || f.Sequence == "0" || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid dismissed frame")
		}
	case "received_message":
		if !ValidULID(f.ChatID) || !validSequence(f.Sequence) || f.Sequence == "0" || f.Kind != "" || f.RecipientID != "" || f.RequestID != "" || f.Body != "" || f.Epoch != "" || f.StreamID != "" || f.LastAppliedSequence != "" {
			return f, errors.New("invalid received message frame")
		}
	default:
		return f, errors.New("unknown frame type")
	}
	return f, nil
}

func validSubscription(s Subscription) bool {
	return ValidULID(s.ChatID) && (s.Kind == "group" || s.Kind == "direct") &&
		(s.LastAppliedSequence == "" || validSequence(s.LastAppliedSequence)) &&
		((s.Epoch == "") == (s.StreamID == ""))
}

func DecodeEvent(data []byte) (Event, error) {
	event, err := messagecodec.Decode[Event](data)
	if err != nil {
		return event, err
	}
	if event.Version != 1 || !ValidULID(event.EventID) || !validRoom(event.Room) || event.Epoch != "" || event.StreamID != "" || event.Code != "" || (event.Type != "session_revoked" && event.SessionID != "") {
		return event, errors.New("invalid event metadata")
	}
	switch event.Type {
	case "message_saved":
		if !ValidULID(event.ChatID) || !ValidULID(event.RequestID) || event.RecipientID != "" || !ValidULID(event.MessageID) || !ValidULID(event.SenderID) || !validSequence(event.Sequence) || event.Sequence == "0" || event.Body == "" || len([]rune(event.Body)) > 4000 || event.Reason != "" {
			return event, errors.New("invalid saved event")
		}
		if _, err := time.Parse(time.RFC3339Nano, event.CreatedAt); err != nil {
			return event, errors.New("invalid event timestamp")
		}
	case "send_rejected":
		if !ValidULID(event.RequestID) || (ValidULID(event.ChatID) == ValidULID(event.RecipientID)) || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" {
			return event, errors.New("invalid rejection event")
		}
		switch event.Reason {
		case "NOT_A_MEMBER", "CHAT_NOT_FOUND", "RECIPIENT_NOT_FOUND", "INVALID_RECIPIENT", "EMPTY_BODY", "BODY_TOO_LONG", "REQUEST_ID_CONFLICT", "PROCESSING_FAILED":
		default:
			return event, errors.New("invalid rejection reason")
		}
	case "chat_created":
		if !ValidULID(event.ChatID) || !strings.HasPrefix(event.Room, "user:") || event.RecipientID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" || (event.RequestID != "" && !ValidULID(event.RequestID)) {
			return event, errors.New("invalid chat creation event")
		}
	case "member_removed":
		if !ValidULID(event.ChatID) || !strings.HasPrefix(event.Room, "user:") || event.SessionID != "" || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return event, errors.New("invalid member removal event")
		}
	case "session_revoked":
		if !strings.HasPrefix(event.Room, "user:") || !ticket.ValidSessionID(event.SessionID) || event.ChatID != "" || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return event, errors.New("invalid session revocation event")
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
