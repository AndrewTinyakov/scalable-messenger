export const FrameType = {
  ACTIVITY: "activity",
  APPLIED: "applied",
  DISMISSED: "dismissed",
  RECEIVED_MESSAGE: "received_message",
  SEND: "send",
  SUBSCRIBE: "subscribe",
  SUBSCRIBE_MANY: "subscribe_many",
  UNSUBSCRIBE: "unsubscribe",
  WATCH_ONLINE_COUNT: "watch_online_count",
  WATCH_PRESENCE: "watch_presence",
  WATCH_SIDEBAR: "watch_sidebar",
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export const EventType = {
  CHAT_CREATED: "chat_created",
  CHAT_DELETED: "chat_deleted",
  CHAT_PREFERENCES_CHANGED: "chat_preferences_changed",
  ERROR: "error",
  HISTORY_CHANGED: "history_changed",
  MEMBER_REMOVED: "member_removed",
  MEMBERSHIP_CHANGED: "membership_changed",
  MESSAGE_CHANGED: "message_changed",
  MESSAGE_SAVED: "message_saved",
  ONLINE_COUNT: "online_count",
  PINS_CHANGED: "pins_changed",
  PRESENCE: "presence",
  PRESENCE_CONFIG: "presence_config",
  QUEUED: "queued",
  READS_CHANGED: "reads_changed",
  RECOVERY_FAILED: "recovery_failed",
  SEND_REJECTED: "send_rejected",
  SESSION_REVOKED: "session_revoked",
  SIDEBAR_ACTIVITY: "sidebar_activity",
  SUBSCRIBED: "subscribed",
  SUBSCRIPTION_EXPIRED: "subscription_expired",
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]

export const ChatKind = {
  DIRECT: "DIRECT",
  GROUP: "GROUP",
} as const

export type ChatKind = (typeof ChatKind)[keyof typeof ChatKind]
