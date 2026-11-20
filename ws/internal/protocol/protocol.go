package protocol

import (
	"errors"
	"regexp"
	"strings"
	"time"

	"messenger/ws/internal/generated/messaging"
	"messenger/ws/internal/messagecodec"
	"messenger/ws/internal/roomname"
	"messenger/ws/internal/ticket"
)

var ulidPattern = regexp.MustCompile(`^[0-7][0-9A-HJKMNP-TV-Z]{25}$`)

type FrameType = messaging.FrameType

const (
	FrameSend            = messaging.FrameSend
	FrameSubscribe       = messaging.FrameSubscribe
	FrameSubscribeMany   = messaging.FrameSubscribeMany
	FrameUnsubscribe     = messaging.FrameUnsubscribe
	FrameApplied         = messaging.FrameApplied
	FrameDismissed       = messaging.FrameDismissed
	FrameReceivedMessage = messaging.FrameReceivedMessage
	FrameWatchSidebar    = messaging.FrameWatchSidebar
	FrameWatchPresence   = messaging.FrameWatchPresence
	FrameUnwatchPresence = messaging.FrameUnwatchPresence
)

type EventType = messaging.EventType

const (
	EventMessageSaved        = messaging.EventMessageSaved
	EventMessageChanged      = messaging.EventMessageChanged
	EventChatDeleted         = messaging.EventChatDeleted
	EventReadsChanged        = messaging.EventReadsChanged
	EventChatPreferences     = messaging.EventChatPreferencesChanged
	EventPinsChanged         = messaging.EventPinsChanged
	EventHistoryChanged      = messaging.EventHistoryChanged
	EventSidebarPresence     = messaging.EventSidebarPresence
	EventSidebarActivity     = messaging.EventSidebarActivity
	EventPresence            = messaging.EventPresence
	EventSendRejected        = messaging.EventSendRejected
	EventChatCreated         = messaging.EventChatCreated
	EventMemberRemoved       = messaging.EventMemberRemoved
	EventMembershipChanged   = messaging.EventMembershipChanged
	EventSessionRevoked      = messaging.EventSessionRevoked
	EventQueued              = messaging.EventQueued
	EventSubscribed          = messaging.EventSubscribed
	EventRecoveryFailed      = messaging.EventRecoveryFailed
	EventSubscriptionExpired = messaging.EventSubscriptionExpired
	EventError               = messaging.EventError
)

type ChatKind = messaging.ChatKind

const (
	ChatDirect = messaging.ChatDirect
	ChatGroup  = messaging.ChatGroup
)

type Frame struct {
	ChatIDs             []string       `json:"chatIds,omitempty"`
	Type                FrameType      `json:"type"`
	Version             int            `json:"version"`
	ChatID              string         `json:"chatId,omitempty"`
	Kind                ChatKind       `json:"kind,omitempty"`
	RecipientID         string         `json:"recipientId,omitempty"`
	RequestID           string         `json:"requestId,omitempty"`
	Body                string         `json:"body,omitempty"`
	Sequence            string         `json:"sequence,omitempty"`
	Epoch               string         `json:"epoch,omitempty"`
	StreamID            string         `json:"streamId,omitempty"`
	LastAppliedSequence string         `json:"lastAppliedSequence,omitempty"`
	Subscriptions       []Subscription `json:"subscriptions,omitempty"`
	ReplyToMessageID    string         `json:"replyToMessageId,omitempty"`
	ForwardFromChatID   string         `json:"forwardFromChatId,omitempty"`
	ForwardFromMsgID    string         `json:"forwardFromMessageId,omitempty"`
	UserIDs             []string       `json:"userIds,omitempty"`
}

type Subscription struct {
	ChatID              string   `json:"chatId"`
	Kind                ChatKind `json:"kind"`
	Epoch               string   `json:"epoch,omitempty"`
	StreamID            string   `json:"streamId,omitempty"`
	LastAppliedSequence string   `json:"lastAppliedSequence,omitempty"`
}

type SendCommand struct {
	Version          int    `json:"version"`
	ChatID           string `json:"chatId"`
	RecipientID      string `json:"recipientId,omitempty"`
	RequestID        string `json:"requestId"`
	SenderID         string `json:"senderId"`
	Body             string `json:"body"`
	SentAt           string `json:"sentAt"`
	ReplyToMessageID string `json:"replyToMessageId,omitempty"`
	ForwardChatID    string `json:"forwardFromChatId,omitempty"`
	ForwardMessageID string `json:"forwardFromMessageId,omitempty"`
}

func (command SendCommand) Wire() messaging.SendMessageCommandV1 {
	return messaging.SendMessageCommandV1{Version: command.Version, ChatId: command.ChatID, RecipientId: command.RecipientID, RequestId: command.RequestID, SenderId: command.SenderID, Body: command.Body, SentAt: command.SentAt, ReplyToMessageId: command.ReplyToMessageID, ForwardFromChatId: command.ForwardChatID, ForwardFromMessageId: command.ForwardMessageID}
}

func DecodeFrame(data []byte) (Frame, error) {
	f, fields, err := messagecodec.DecodeObject[Frame](data)
	if err != nil {
		return f, err
	}
	if err := validateFrameFields(f, fields); err != nil {
		return f, err
	}
	if f.Version != 1 {
		return f, errors.New("unsupported frame version")
	}
	if f.Type != FrameSubscribeMany && f.Subscriptions != nil {
		return f, errors.New("unexpected subscriptions")
	}
	if err := validateFeatureFrame(f); err != nil {
		return f, err
	}
	switch f.Type {
	case FrameSend:
		err = validateSendFrame(f)
	case FrameWatchSidebar:
		err = validateWatchSidebarFrame(f)
	case FrameWatchPresence, FrameUnwatchPresence:
	case FrameSubscribe:
		err = validateSubscribeFrame(f)
	case FrameSubscribeMany:
		err = validateSubscribeManyFrame(f)
	case FrameUnsubscribe:
		err = validateUnsubscribeFrame(f)
	case FrameApplied:
		err = validateAppliedFrame(f)
	case FrameDismissed:
		err = validateDismissedFrame(f)
	case FrameReceivedMessage:
		err = validateReceivedMessageFrame(f)
	default:
		return f, errors.New("unknown frame type")
	}
	return f, err
}

func validSubscription(s Subscription) bool {
	return ValidULID(s.ChatID) && (s.Kind == ChatGroup || s.Kind == ChatDirect) &&
		(s.LastAppliedSequence == "" || validSequence(s.LastAppliedSequence)) &&
		((s.Epoch == "") == (s.StreamID == ""))
}

func DecodeEvent(data []byte) (Event, error) {
	event, fields, err := messagecodec.DecodeObject[Event](data)
	if err != nil {
		return event, err
	}
	if err := validateEventFields(event, fields); err != nil {
		return event, err
	}
	if event.Type == EventMembershipChanged {
		if _, err := messagecodec.Decode[messaging.MembershipChangedEventV1](data); err != nil {
			return event, err
		}
	}
	return event, ValidateEvent(event)
}

func ValidateEvent(event Event) error {
	if event.Version != 1 || !ValidULID(event.EventID) || !validRoom(event.Room) || event.Epoch != "" || event.StreamID != "" || event.Code != "" || (event.Type != EventSessionRevoked && event.SessionID != "") || (event.Type != EventMemberRemoved && event.MemberID != "") {
		return errors.New("invalid event metadata")
	}
	if err := validateFeatureEvent(event); err != nil {
		return err
	}
	if err := validateEventCounters(event); err != nil {
		return err
	}
	switch event.Type {
	case EventMessageSaved:
		if !ValidULID(event.ChatID) || !ValidULID(event.RequestID) || event.RecipientID != "" || !ValidULID(event.MessageID) || !ValidULID(event.SenderID) || !validSequence(event.Sequence) || event.Sequence == "0" || event.Body == "" || len([]rune(event.Body)) > 4000 || event.Reason != "" {
			return errors.New("invalid saved event")
		}
		if _, err := time.Parse(time.RFC3339Nano, event.CreatedAt); err != nil {
			return errors.New("invalid event timestamp")
		}
	case EventHistoryChanged:
		if !ValidULID(event.ChatID) || !validSequence(event.Sequence) || event.Body != "" || event.MessageID != "" || event.RequestID != "" || event.SenderID != "" || event.CreatedAt != "" || event.RecipientID != "" || event.Reason != "" {
			return errors.New("invalid history change event")
		}
	case EventMessageChanged:
		return validateChangedMessage(event)
	case EventChatPreferences, EventPinsChanged:
		if !ValidULID(event.ChatID) || (event.Type == EventChatPreferences && !roomname.IsUser(event.Room)) || (roomname.IsGroup(event.Room) && event.Room != roomname.Group(event.ChatID)) || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return errors.New("invalid personal chat event")
		}
	case EventChatDeleted, EventReadsChanged:
		if !ValidULID(event.ChatID) || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return errors.New("invalid chat feature event")
		}
	case EventSendRejected:
		if !ValidULID(event.RequestID) || (event.ChatID == "") == (event.RecipientID == "") || (event.ChatID != "" && !ValidULID(event.ChatID)) || (event.RecipientID != "" && !ValidULID(event.RecipientID)) || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" {
			return errors.New("invalid rejection event")
		}
		if _, valid := messaging.ValuesToSendRejectionReason[event.Reason]; !valid {
			return errors.New("invalid rejection reason")
		}
	case EventChatCreated:
		if !ValidULID(event.ChatID) || !roomname.IsUser(event.Room) || event.RecipientID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" || (event.RequestID != "" && !ValidULID(event.RequestID)) {
			return errors.New("invalid chat creation event")
		}
	case EventMembershipChanged:
		if !ValidULID(event.ChatID) || event.Room != roomname.Group(event.ChatID) || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return errors.New("invalid membership change event")
		}
	case EventMemberRemoved:
		if !ValidULID(event.ChatID) || !ValidULID(event.MemberID) || (event.Room != roomname.User(event.MemberID) && event.Room != roomname.Group(event.ChatID)) || event.SessionID != "" || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return errors.New("invalid member removal event")
		}
	case EventSessionRevoked:
		if !roomname.IsUser(event.Room) || !ticket.ValidSessionID(event.SessionID) || event.ChatID != "" || event.RecipientID != "" || event.RequestID != "" || event.MessageID != "" || event.Sequence != "" || event.SenderID != "" || event.Body != "" || event.CreatedAt != "" || event.Reason != "" {
			return errors.New("invalid session revocation event")
		}
	default:
		return errors.New("unknown event type")
	}
	return nil
}

func validRoom(room string) bool {
	return (roomname.IsUser(room) && ValidULID(strings.TrimPrefix(room, roomname.UserPrefix))) ||
		(roomname.IsGroup(room) && ValidULID(strings.TrimPrefix(room, roomname.GroupPrefix)))
}

func ValidULID(s string) bool { return ulidPattern.MatchString(s) }
func validSequence(s string) bool {
	if s == "" || len(s) > 19 || (len(s) == 19 && s > "9223372036854775807") {
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
