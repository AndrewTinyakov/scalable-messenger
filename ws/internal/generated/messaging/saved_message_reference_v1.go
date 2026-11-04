package messaging

type SavedMessageReferenceV1 struct {
	ReservedType string `json:"type" binding:"required"`
	Version      int    `json:"version" binding:"required"`
	EventId      string `json:"eventId" binding:"required"`
	Room         string `json:"room" binding:"required"`
	ChatId       string `json:"chatId" binding:"required"`
	RequestId    string `json:"requestId" binding:"required"`
	MessageId    string `json:"messageId" binding:"required"`
	Sequence     string `json:"sequence" binding:"required"`
}
