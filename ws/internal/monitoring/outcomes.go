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

type SubscriptionRefusal string

const (
	SubscriptionRefusedUserLimit      SubscriptionRefusal = "user_limit"
	SubscriptionRefusedAuthSlots      SubscriptionRefusal = "auth_slots"
	SubscriptionRefusedFinalAuthSlots SubscriptionRefusal = "final_auth_slots"
	SubscriptionRefusedRoomLimit      SubscriptionRefusal = "room_limit"
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
	HandshakeInvalidTicket        HandshakeOutcome = "invalid_ticket"
	HandshakeInvalidOrigin        HandshakeOutcome = "invalid_origin"
	HandshakeCapacity             HandshakeOutcome = "capacity"
	HandshakeLimitUnavailable     HandshakeOutcome = "handshake_limit_unavailable"
	HandshakeRateLimited          HandshakeOutcome = "handshake_rate_limited"
	HandshakeAdmissionUnavailable HandshakeOutcome = "admission_unavailable"
	HandshakeUserCapacity         HandshakeOutcome = "user_capacity"
	HandshakeUpgradeError         HandshakeOutcome = "upgrade_error"
	HandshakeRoomJoinFailed       HandshakeOutcome = "room_join_failed"
	HandshakeSessionRevoked       HandshakeOutcome = "session_revoked"
	HandshakeSessionUnavailable   HandshakeOutcome = "session_unavailable"
	HandshakeSessionMismatch      HandshakeOutcome = "session_mismatch"
	HandshakeAccepted             HandshakeOutcome = "accepted"
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

type RoomFailureReason string

const (
	RoomFeedStopped        RoomFailureReason = "feed_stopped"
	RoomPositionReadFailed RoomFailureReason = "position_read_failed"
	RoomEpochChanged       RoomFailureReason = "epoch_changed"
	RoomUnrepairedGap      RoomFailureReason = "unrepaired_gap"
	RoomReplayFailed       RoomFailureReason = "replay_failed"
	RoomFrameEncodeFailed  RoomFailureReason = "frame_encode_failed"
)

var roomFailureReasons = []RoomFailureReason{RoomFeedStopped, RoomPositionReadFailed, RoomEpochChanged, RoomUnrepairedGap, RoomReplayFailed, RoomFrameEncodeFailed}
