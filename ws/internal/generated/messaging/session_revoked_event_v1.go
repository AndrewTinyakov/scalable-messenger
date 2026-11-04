package messaging

type SessionRevokedEventV1 struct {
	ReservedType string `json:"type" binding:"required"`
	Version      int    `json:"version" binding:"required"`
	EventId      string `json:"eventId" binding:"required"`
	Room         string `json:"room" binding:"required"`
	SessionId    string `json:"sessionId" binding:"required"`
}
