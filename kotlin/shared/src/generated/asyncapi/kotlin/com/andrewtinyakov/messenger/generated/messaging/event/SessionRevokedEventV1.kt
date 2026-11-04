package com.andrewtinyakov.messenger.generated.messaging.event


data class SessionRevokedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val sessionId: String,
) {
    init {
        require(type == "session_revoked" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            sessionId: String,
        ): SessionRevokedEventV1 = SessionRevokedEventV1(
            type = RoomEventType.SESSION_REVOKED.value,
            version = 1,
            eventId = eventId,
            room = room,
            sessionId = sessionId,
        )
    }
}
