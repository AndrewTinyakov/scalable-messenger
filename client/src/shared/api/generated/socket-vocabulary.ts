export const FrameType = {
  APPLIED: "applied",
  DISMISSED: "dismissed",
  RECEIVED_MESSAGE: "received_message",
  SEND: "send",
  SUBSCRIBE: "subscribe",
  SUBSCRIBE_MANY: "subscribe_many",
  UNSUBSCRIBE: "unsubscribe",
  UNWATCH_PRESENCE: "unwatch_presence",
  WATCH_PRESENCE: "watch_presence",
  WATCH_SIDEBAR: "watch_sidebar",
} as const

export type FrameType = (typeof FrameType)[keyof typeof FrameType]

export const EventType = {
  CHAT_CREATED: "chat_created",
  CHAT_DELETED: "chat_deleted",
  ERROR: "error",
  HISTORY_CHANGED: "history_changed",
  MEMBER_REMOVED: "member_removed",
  MEMBERSHIP_CHANGED: "membership_changed",
  MESSAGE_CHANGED: "message_changed",
  MESSAGE_SAVED: "message_saved",
  PRESENCE: "presence",
  QUEUED: "queued",
  READS_CHANGED: "reads_changed",
  RECOVERY_FAILED: "recovery_failed",
  SEND_REJECTED: "send_rejected",
  SESSION_REVOKED: "session_revoked",
  SIDEBAR_ACTIVITY: "sidebar_activity",
  SIDEBAR_PRESENCE: "sidebar_presence",
  SUBSCRIBED: "subscribed",
  SUBSCRIPTION_EXPIRED: "subscription_expired",
} as const

export type EventType = (typeof EventType)[keyof typeof EventType]

export const ChatKind = {
  DIRECT: "DIRECT",
  GROUP: "GROUP",
} as const

export type ChatKind = (typeof ChatKind)[keyof typeof ChatKind]
