package messaging

type SendMessageCommandV1 struct {
	Version        int    `json:"version" binding:"required"`
	ConversationId string `json:"conversationId" binding:"required"`
	RequestId      string `json:"requestId" binding:"required"`
	SenderId       string `json:"senderId" binding:"required"`
	Body           string `json:"body" binding:"required"`
	SentAt         string `json:"sentAt" binding:"required"`
}
