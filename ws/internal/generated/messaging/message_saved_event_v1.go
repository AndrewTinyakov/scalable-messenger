package messaging

type MessageSavedEventV1 struct {
	ReservedType   string `json:"type" binding:"required"`
	Version        int    `json:"version" binding:"required"`
	EventId        string `json:"eventId" binding:"required"`
	Room           string `json:"room" binding:"required"`
	ConversationId string `json:"conversationId" binding:"required"`
	RequestId      string `json:"requestId" binding:"required"`
	MessageId      string `json:"messageId" binding:"required"`
	Sequence       string `json:"sequence" binding:"required"`
	SenderId       string `json:"senderId" binding:"required"`
	Body           string `json:"body" binding:"required"`
	CreatedAt      string `json:"createdAt" binding:"required"`
}
