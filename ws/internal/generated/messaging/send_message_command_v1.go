package messaging

type SendMessageCommandV1 struct {
	Version              int    `json:"version" binding:"required"`
	ChatId               string `json:"chatId,omitempty"`
	RecipientId          string `json:"recipientId,omitempty"`
	RequestId            string `json:"requestId" binding:"required"`
	SenderId             string `json:"senderId" binding:"required"`
	Body                 string `json:"body" binding:"required"`
	SentAt               string `json:"sentAt" binding:"required"`
	ReplyToMessageId     string `json:"replyToMessageId,omitempty"`
	ForwardFromChatId    string `json:"forwardFromChatId,omitempty"`
	ForwardFromMessageId string `json:"forwardFromMessageId,omitempty"`
}
