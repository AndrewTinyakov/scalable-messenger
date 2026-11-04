package monitoring

type PublishOutcome string

const (
	PublishFailed    PublishOutcome = "failed"
	PublishConfirmed PublishOutcome = "confirmed"
)

type PublishStageOutcome string

const (
	PublishStageReady  PublishStageOutcome = "ready"
	PublishStageFailed PublishStageOutcome = "failed"
)

type PublishConfirmationOutcome string

const (
	PublishConfirmationConfirmed PublishConfirmationOutcome = "confirmed"
	PublishConfirmationRejected  PublishConfirmationOutcome = "rejected"
	PublishConfirmationUnknown   PublishConfirmationOutcome = "unknown"
)

type AcknowledgementOutcome string

const (
	AcknowledgementRejected AcknowledgementOutcome = "rejected"
	AcknowledgementAccepted AcknowledgementOutcome = "accepted"
)

type AuthorizationOutcome string

const (
	AuthorizationAuthorized AuthorizationOutcome = "authorized"
	AuthorizationDenied     AuthorizationOutcome = "denied"
	AuthorizationError      AuthorizationOutcome = "error"
)

type ReplayOutcome string

const (
	ReplayFallback ReplayOutcome = "fallback"
	ReplayComplete ReplayOutcome = "complete"
)

type HandshakeOutcome string

const (
	HandshakeInvalidTicket      HandshakeOutcome = "invalid_ticket"
	HandshakeInvalidOrigin      HandshakeOutcome = "invalid_origin"
	HandshakeCapacity           HandshakeOutcome = "capacity"
	HandshakeLimitUnavailable   HandshakeOutcome = "handshake_limit_unavailable"
	HandshakeRateLimited        HandshakeOutcome = "handshake_rate_limited"
	HandshakeLeaseUnavailable   HandshakeOutcome = "lease_unavailable"
	HandshakeUserCapacity       HandshakeOutcome = "user_capacity"
	HandshakeUpgradeError       HandshakeOutcome = "upgrade_error"
	HandshakeRoomJoinFailed     HandshakeOutcome = "room_join_failed"
	HandshakeSessionRevoked     HandshakeOutcome = "session_revoked"
	HandshakeSessionUnavailable HandshakeOutcome = "session_unavailable"
	HandshakeSessionMismatch    HandshakeOutcome = "session_mismatch"
	HandshakeAccepted           HandshakeOutcome = "accepted"
)

type CapacityResource string

const (
	CapacityConnections                CapacityResource = "connections"
	CapacityRooms                      CapacityResource = "rooms"
	CapacityMemberships                CapacityResource = "memberships"
	CapacityCommandItems               CapacityResource = "command_items"
	CapacityCommandBytes               CapacityResource = "command_bytes"
	CapacityOutboundItemsPerConnection CapacityResource = "outbound_items_per_connection"
	CapacityOutboundBytesPerConnection CapacityResource = "outbound_bytes_per_connection"
)
