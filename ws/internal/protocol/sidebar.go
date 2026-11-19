package protocol

import (
	"errors"
	"regexp"
	"time"
	"unicode/utf8"

	"messenger/ws/internal/generated/messaging"
	"messenger/ws/internal/messagecodec"
)

var usernamePattern = regexp.MustCompile(`^[a-z0-9_]{3,40}$`)

// validActivityMessage accepts activity without a message, or with every message field present and valid.
func validActivityMessage(event Event) bool {
	if event.MessageID == "" && event.SenderID == "" && event.SenderUsername == "" && event.CreatedAt == "" && event.Preview == "" {
		return true
	}
	_, err := time.Parse(time.RFC3339Nano, event.CreatedAt)
	length := utf8.RuneCountInString(event.Preview)
	return ValidULID(event.MessageID) && ValidULID(event.SenderID) && usernamePattern.MatchString(event.SenderUsername) &&
		err == nil && utf8.ValidString(event.Preview) && length >= 1 && length <= 160
}

func DecodeSidebarEvent(data []byte) (Event, error) {
	event, fields, err := messagecodec.DecodeObject[Event](data)
	if err != nil {
		return event, err
	}
	if event.Version != 1 {
		return event, errors.New("invalid sidebar version")
	}
	switch event.Type {
	case EventSidebarActivity:
		shape := messaging.RoomShapes[EventSidebarActivity]
		if !fields.Match(shape.Required, shape.Optional) || !ValidULID(event.ChatID) || !validSequence(event.Sequence) || event.Sequence == "0" || !validActivityMessage(event) {
			return event, errors.New("invalid sidebar activity")
		}
	case EventSidebarPresence:
		if !fields.Match([]string{"type", "version", "observedAt", "validForMs", "statuses"}, nil) || event.ValidForMS < 1 || event.ValidForMS > 30000 || event.Statuses == nil || len(event.Statuses) > 100 {
			return event, errors.New("invalid sidebar presence")
		}
		if _, err := time.Parse(time.RFC3339Nano, event.ObservedAt); err != nil {
			return event, err
		}
		seen := make(map[string]bool, len(event.Statuses))
		for _, peer := range event.Statuses {
			if !ValidULID(peer.UserID) || seen[peer.UserID] || (peer.State != "online" && peer.State != "offline" && peer.State != "unknown") {
				return event, errors.New("invalid sidebar status")
			}
			seen[peer.UserID] = true
		}
	default:
		return event, errors.New("invalid sidebar type")
	}
	return event, nil
}
