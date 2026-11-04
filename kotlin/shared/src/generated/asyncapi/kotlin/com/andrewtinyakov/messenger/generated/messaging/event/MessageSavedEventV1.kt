package com.andrewtinyakov.messenger.generated.messaging.event


data class MessageSavedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val requestId: String,
    val messageId: String,
    val sequence: String,
    val senderId: String,
    val body: String,
    val createdAt: java.time.OffsetDateTime,
    val messageVersion: String? = null,
    val replyToMessageId: String? = null,
    val replySenderId: String? = null,
    val replyBody: String? = null,
    val replyDeleted: Boolean? = null,
    val replyVersion: String? = null,
) {
    init {
        require(type == "message_saved" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            requestId: String,
            messageId: String,
            sequence: String,
            senderId: String,
            body: String,
            createdAt: java.time.OffsetDateTime,
            messageVersion: String? = null,
            replyToMessageId: String? = null,
            replySenderId: String? = null,
            replyBody: String? = null,
            replyDeleted: Boolean? = null,
            replyVersion: String? = null,
        ): MessageSavedEventV1 = MessageSavedEventV1(
            type = RoomEventType.MESSAGE_SAVED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            requestId = requestId,
            messageId = messageId,
            sequence = sequence,
            senderId = senderId,
            body = body,
            createdAt = createdAt,
            messageVersion = messageVersion,
            replyToMessageId = replyToMessageId,
            replySenderId = replySenderId,
            replyBody = replyBody,
            replyDeleted = replyDeleted,
            replyVersion = replyVersion,
        )
    }
}
