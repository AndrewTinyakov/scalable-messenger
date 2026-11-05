package messaging

type EventType string
type RoomEventType = EventType
type FrameType string
type ChatKind string

const (
	EventChatCreated         EventType = "chat_created"
	EventChatDeleted         EventType = "chat_deleted"
	EventError               EventType = "error"
	EventHistoryChanged      EventType = "history_changed"
	EventMemberRemoved       EventType = "member_removed"
	EventMembershipChanged   EventType = "membership_changed"
	EventMessageChanged      EventType = "message_changed"
	EventMessageSaved        EventType = "message_saved"
	EventPresence            EventType = "presence"
	EventQueued              EventType = "queued"
	EventReadsChanged        EventType = "reads_changed"
	EventRecoveryFailed      EventType = "recovery_failed"
	EventSendRejected        EventType = "send_rejected"
	EventSessionRevoked      EventType = "session_revoked"
	EventSidebarActivity     EventType = "sidebar_activity"
	EventSidebarPresence     EventType = "sidebar_presence"
	EventSubscribed          EventType = "subscribed"
	EventSubscriptionExpired EventType = "subscription_expired"
)

const (
	FrameApplied         FrameType = "applied"
	FrameDismissed       FrameType = "dismissed"
	FrameReceivedMessage FrameType = "received_message"
	FrameSend            FrameType = "send"
	FrameSubscribe       FrameType = "subscribe"
	FrameSubscribeMany   FrameType = "subscribe_many"
	FrameUnsubscribe     FrameType = "unsubscribe"
	FrameUnwatchPresence FrameType = "unwatch_presence"
	FrameWatchPresence   FrameType = "watch_presence"
	FrameWatchSidebar    FrameType = "watch_sidebar"
)

const (
	ChatDirect ChatKind = "DIRECT"
	ChatGroup  ChatKind = "GROUP"
)
