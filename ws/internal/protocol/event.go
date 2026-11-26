package protocol

import "encoding/json"

type Event struct {
	Type                 EventType        `json:"type"`
	Version              int              `json:"version,omitempty"`
	EventID              string           `json:"eventId,omitempty"`
	Room                 string           `json:"room,omitempty"`
	SessionID            string           `json:"sessionId,omitempty"`
	MemberID             string           `json:"memberId,omitempty"`
	ChatID               string           `json:"chatId,omitempty"`
	RecipientID          string           `json:"recipientId,omitempty"`
	RequestID            string           `json:"requestId,omitempty"`
	MessageID            string           `json:"messageId,omitempty"`
	Sequence             string           `json:"sequence,omitempty"`
	SenderID             string           `json:"senderId,omitempty"`
	SenderUsername       string           `json:"senderUsername,omitempty"`
	Body                 string           `json:"body,omitempty"`
	CreatedAt            string           `json:"createdAt,omitempty"`
	Preview              string           `json:"preview,omitempty"`
	Reason               string           `json:"reason,omitempty"`
	Epoch                string           `json:"epoch,omitempty"`
	StreamID             string           `json:"streamId,omitempty"`
	Code                 ErrorCode        `json:"code,omitempty"`
	MessageVersion       string           `json:"messageVersion,omitempty"`
	Seq                  string           `json:"seq,omitempty"`
	MemberSeq            string           `json:"memberSeq,omitempty"`
	UserSeq              string           `json:"userSeq,omitempty"`
	EditedAt             string           `json:"editedAt,omitempty"`
	DeletedAt            string           `json:"deletedAt,omitempty"`
	ReplyToMessageID     string           `json:"replyToMessageId,omitempty"`
	ReplySenderID        string           `json:"replySenderId,omitempty"`
	ReplyBody            string           `json:"replyBody,omitempty"`
	ReplyDeleted         *bool            `json:"replyDeleted,omitempty"`
	ReplyVersion         string           `json:"replyVersion,omitempty"`
	ForwardedFromUserID  string           `json:"forwardedFromUserId,omitempty"`
	Statuses             []PresenceStatus `json:"statuses,omitempty"`
	Unavailable          []string         `json:"unavailable,omitempty"`
	Online               int              `json:"online,omitempty"`
	Members              int              `json:"members,omitempty"`
	IdleAfterHiddenMS    int              `json:"idleAfterHiddenMs,omitempty"`
	IdleAfterInputMS     int              `json:"idleAfterInputMs,omitempty"`
	ReleaseAfterHiddenMS int              `json:"releaseAfterHiddenMs,omitempty"`
}

type PresenceStatus struct {
	UserID     string `json:"userId"`
	Online     bool   `json:"online"`
	LastSeenAt string `json:"lastSeenAt,omitempty"`
	LastSeen   string `json:"lastSeen,omitempty"`
}

func (event Event) MarshalJSON() ([]byte, error) {
	type wireEvent Event
	if event.Type == EventPresenceConfig {
		return json.Marshal(struct {
			Type                 EventType `json:"type"`
			Version              int       `json:"version"`
			IdleAfterHiddenMS    int       `json:"idleAfterHiddenMs"`
			IdleAfterInputMS     int       `json:"idleAfterInputMs"`
			ReleaseAfterHiddenMS int       `json:"releaseAfterHiddenMs"`
		}{event.Type, event.Version, event.IdleAfterHiddenMS, event.IdleAfterInputMS, event.ReleaseAfterHiddenMS})
	}
	if event.Type != EventMessageChanged && event.Type != EventPresence && event.Type != EventOnlineCount && event.ReplyToMessageID == "" {
		return json.Marshal(wireEvent(event))
	}
	var body, replyBody *string
	var statuses *[]PresenceStatus
	var online *int
	if event.Type == EventPresence {
		value := event.Statuses
		if value == nil {
			value = []PresenceStatus{}
		}
		statuses = &value
	}
	if event.Type == EventOnlineCount {
		online = &event.Online
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
		Online    *int              `json:"online,omitempty"`
	}{wireEvent: (*wireEvent)(&event), Body: body, ReplyBody: replyBody, Statuses: statuses, Online: online})
}
