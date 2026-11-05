package com.andrewtinyakov.messenger.generated.messaging.event

enum class RoomEventType(val value: String) {
    CHAT_CREATED("chat_created"),
    CHAT_DELETED("chat_deleted"),
    CHAT_PREFERENCES_CHANGED("chat_preferences_changed"),
    HISTORY_CHANGED("history_changed"),
    MEMBER_REMOVED("member_removed"),
    MEMBERSHIP_CHANGED("membership_changed"),
    MESSAGE_CHANGED("message_changed"),
    MESSAGE_SAVED("message_saved"),
    PINS_CHANGED("pins_changed"),
    READS_CHANGED("reads_changed"),
    SEND_REJECTED("send_rejected"),
    SESSION_REVOKED("session_revoked"),
    SIDEBAR_ACTIVITY("sidebar_activity"),
}
