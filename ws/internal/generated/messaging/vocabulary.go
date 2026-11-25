package messaging

type EventType string
type RoomEventType = EventType
type FrameType string
type ChatKind string

const (
	EventChatCreated            EventType = "chat_created"
	EventChatDeleted            EventType = "chat_deleted"
	EventChatPreferencesChanged EventType = "chat_preferences_changed"
	EventError                  EventType = "error"
	EventHistoryChanged         EventType = "history_changed"
	EventMemberRemoved          EventType = "member_removed"
	EventMembershipChanged      EventType = "membership_changed"
	EventMessageChanged         EventType = "message_changed"
	EventMessageSaved           EventType = "message_saved"
	EventOnlineCount            EventType = "online_count"
	EventPinsChanged            EventType = "pins_changed"
	EventPresence               EventType = "presence"
	EventPresenceConfig         EventType = "presence_config"
	EventQueued                 EventType = "queued"
	EventReadsChanged           EventType = "reads_changed"
	EventRecoveryFailed         EventType = "recovery_failed"
	EventSendRejected           EventType = "send_rejected"
	EventSessionRevoked         EventType = "session_revoked"
	EventSidebarActivity        EventType = "sidebar_activity"
	EventSubscribed             EventType = "subscribed"
	EventSubscriptionExpired    EventType = "subscription_expired"
)

const (
	FrameActivity         FrameType = "activity"
	FrameApplied          FrameType = "applied"
	FrameDismissed        FrameType = "dismissed"
	FrameReceivedMessage  FrameType = "received_message"
	FrameSend             FrameType = "send"
	FrameSubscribe        FrameType = "subscribe"
	FrameSubscribeMany    FrameType = "subscribe_many"
	FrameUnsubscribe      FrameType = "unsubscribe"
	FrameWatchOnlineCount FrameType = "watch_online_count"
	FrameWatchPresence    FrameType = "watch_presence"
	FrameWatchSidebar     FrameType = "watch_sidebar"
)

const (
	ChatDirect ChatKind = "DIRECT"
	ChatGroup  ChatKind = "GROUP"
)
