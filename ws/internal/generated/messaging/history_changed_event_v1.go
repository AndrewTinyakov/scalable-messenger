package messaging

type HistoryChangedEventV1 struct {
	ReservedType string `json:"type" binding:"required"`
	Version      int    `json:"version" binding:"required"`
	EventId      string `json:"eventId" binding:"required"`
	Room         string `json:"room" binding:"required"`
	ChatId       string `json:"chatId" binding:"required"`
	Sequence     string `json:"sequence" binding:"required"`
	Seq          string `json:"seq,omitempty"`
	MemberSeq    string `json:"memberSeq,omitempty"`
}
