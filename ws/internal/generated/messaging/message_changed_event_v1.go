package messaging

type MessageChangedEventV1 struct {
	ReservedType     string `json:"type" binding:"required"`
	Version          int    `json:"version" binding:"required"`
	EventId          string `json:"eventId" binding:"required"`
	Room             string `json:"room" binding:"required"`
	ChatId           string `json:"chatId" binding:"required"`
	MessageId        string `json:"messageId" binding:"required"`
	Sequence         string `json:"sequence" binding:"required"`
	SenderId         string `json:"senderId" binding:"required"`
	Body             string `json:"body" binding:"required"`
	CreatedAt        string `json:"createdAt" binding:"required"`
	MessageVersion   string `json:"messageVersion" binding:"required"`
	EditedAt         string `json:"editedAt,omitempty"`
	DeletedAt        string `json:"deletedAt,omitempty"`
	ReplyToMessageId string `json:"replyToMessageId,omitempty"`
	ReplySenderId    string `json:"replySenderId,omitempty"`
	ReplyBody        string `json:"replyBody,omitempty"`
	ReplyDeleted     bool   `json:"replyDeleted,omitempty"`
	ReplyVersion     string `json:"replyVersion,omitempty"`
	Seq              string `json:"seq" binding:"required"`
}
