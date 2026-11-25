package messaging

type SidebarActivityEventV1 struct {
	ReservedType   string `json:"type" binding:"required"`
	Version        int    `json:"version" binding:"required"`
	ChatId         string `json:"chatId" binding:"required"`
	Sequence       string `json:"sequence" binding:"required"`
	MessageId      string `json:"messageId,omitempty"`
	SenderId       string `json:"senderId,omitempty"`
	SenderUsername string `json:"senderUsername,omitempty"`
	CreatedAt      string `json:"createdAt,omitempty"`
	Preview        string `json:"preview,omitempty"`
}
