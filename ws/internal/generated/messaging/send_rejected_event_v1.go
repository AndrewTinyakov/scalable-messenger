package messaging

type SendRejectedEventV1 struct {
	ReservedType string               `json:"type" binding:"required"`
	Version      int                  `json:"version" binding:"required"`
	EventId      string               `json:"eventId" binding:"required"`
	Room         string               `json:"room" binding:"required"`
	ChatId       string               `json:"chatId,omitempty"`
	RecipientId  string               `json:"recipientId,omitempty"`
	RequestId    string               `json:"requestId" binding:"required"`
	Reason       *SendRejectionReason `json:"reason" binding:"required"`
}
