package protocol

import "encoding/json"

type Event struct {
	Type                EventType        `json:"type"`
	Version             int              `json:"version,omitempty"`
	EventID             string           `json:"eventId,omitempty"`
	Room                string           `json:"room,omitempty"`
	SessionID           string           `json:"sessionId,omitempty"`
	MemberID            string           `json:"memberId,omitempty"`
	ChatID              string           `json:"chatId,omitempty"`
	RecipientID         string           `json:"recipientId,omitempty"`
	RequestID           string           `json:"requestId,omitempty"`
	MessageID           string           `json:"messageId,omitempty"`
	Sequence            string           `json:"sequence,omitempty"`
	SenderID            string           `json:"senderId,omitempty"`
	Body                string           `json:"body,omitempty"`
	CreatedAt           string           `json:"createdAt,omitempty"`
	Reason              string           `json:"reason,omitempty"`
	Epoch               string           `json:"epoch,omitempty"`
	StreamID            string           `json:"streamId,omitempty"`
	Code                ErrorCode        `json:"code,omitempty"`
	MessageVersion      string           `json:"messageVersion,omitempty"`
	VisibilityRevision  string           `json:"visibilityRevision,omitempty"`
	MutationRevision    string           `json:"mutationRevision,omitempty"`
	EditedAt            string           `json:"editedAt,omitempty"`
	DeletedAt           string           `json:"deletedAt,omitempty"`
	ReplyToMessageID    string           `json:"replyToMessageId,omitempty"`
	ReplySenderID       string           `json:"replySenderId,omitempty"`
	ReplyBody           string           `json:"replyBody,omitempty"`
	ReplyDeleted        *bool            `json:"replyDeleted,omitempty"`
	ReplyVersion        string           `json:"replyVersion,omitempty"`
	ForwardedFromUserID string           `json:"forwardedFromUserId,omitempty"`
	ObservedAt          string           `json:"observedAt,omitempty"`
	ValidForMS          int              `json:"validForMs,omitempty"`
	Statuses            []PresenceStatus `json:"statuses,omitempty"`
}

type PresenceStatus struct {
	UserID string `json:"userId"`
	State  string `json:"state"`
}

func (event Event) MarshalJSON() ([]byte, error) {
	type wireEvent Event
	if event.Type != EventMessageChanged && event.Type != EventPresence && event.Type != EventSidebarPresence && event.ReplyToMessageID == "" {
		return json.Marshal(wireEvent(event))
	}
	var body, replyBody *string
	var statuses *[]PresenceStatus
	if event.Type == EventPresence || event.Type == EventSidebarPresence {
		value := event.Statuses
		if value == nil {
			value = []PresenceStatus{}
		}
		statuses = &value
	}
	if event.Body != "" || event.Type == EventMessageChanged {
		body = &event.Body
	}
	if event.ReplyToMessageID != "" && event.ReplyDeleted != nil {
		replyBody = &event.ReplyBody
	}
	return json.Marshal(struct {
		*wireEvent
		Body      *string           `json:"body,omitempty"`
		ReplyBody *string           `json:"replyBody,omitempty"`
		Statuses  *[]PresenceStatus `json:"statuses,omitempty"`
	}{wireEvent: (*wireEvent)(&event), Body: body, ReplyBody: replyBody, Statuses: statuses})
}
