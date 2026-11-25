package messaging

type ChatDeletedEventV1 struct {
	ReservedType string `json:"type" binding:"required"`
	Version      int    `json:"version" binding:"required"`
	EventId      string `json:"eventId" binding:"required"`
	Room         string `json:"room" binding:"required"`
	ChatId       string `json:"chatId" binding:"required"`
	Seq          string `json:"seq" binding:"required"`
}
