package messaging

type MessageSavedEventV1 struct {
	ReservedType     string `json:"type" binding:"required"`
	Version          int    `json:"version" binding:"required"`
	EventId          string `json:"eventId" binding:"required"`
	Room             string `json:"room" binding:"required"`
	ChatId           string `json:"chatId" binding:"required"`
	RequestId        string `json:"requestId" binding:"required"`
	MessageId        string `json:"messageId" binding:"required"`
	Sequence         string `json:"sequence" binding:"required"`
	SenderId         string `json:"senderId" binding:"required"`
	Body             string `json:"body" binding:"required"`
	CreatedAt        string `json:"createdAt" binding:"required"`
	MessageVersion   string `json:"messageVersion,omitempty"`
	ReplyToMessageId string `json:"replyToMessageId,omitempty"`
	ReplySenderId    string `json:"replySenderId,omitempty"`
	ReplyBody        string `json:"replyBody,omitempty"`
	ReplyDeleted     bool   `json:"replyDeleted,omitempty"`
	ReplyVersion     string `json:"replyVersion,omitempty"`
}
