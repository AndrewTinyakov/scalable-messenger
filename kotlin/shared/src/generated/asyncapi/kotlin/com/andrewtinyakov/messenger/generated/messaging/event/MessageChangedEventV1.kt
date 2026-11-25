package com.andrewtinyakov.messenger.generated.messaging.event


data class MessageChangedEventV1(
    val type: String,
    val version: Int,
    val eventId: String,
    val room: String,
    val chatId: String,
    val messageId: String,
    val sequence: String,
    val senderId: String,
    val body: String,
    val createdAt: java.time.OffsetDateTime,
    val messageVersion: String,
    val editedAt: java.time.OffsetDateTime? = null,
    val deletedAt: java.time.OffsetDateTime? = null,
    val replyToMessageId: String? = null,
    val replySenderId: String? = null,
    val replyBody: String? = null,
    val replyDeleted: Boolean? = null,
    val replyVersion: String? = null,
    val seq: String,
) {
    init {
        require(type == "message_changed" && version == 1)
    }

    companion object {
        fun create(
            eventId: String,
            room: String,
            chatId: String,
            messageId: String,
            sequence: String,
            senderId: String,
            body: String,
            createdAt: java.time.OffsetDateTime,
            messageVersion: String,
            editedAt: java.time.OffsetDateTime? = null,
            deletedAt: java.time.OffsetDateTime? = null,
            replyToMessageId: String? = null,
            replySenderId: String? = null,
            replyBody: String? = null,
            replyDeleted: Boolean? = null,
            replyVersion: String? = null,
            seq: String,
        ): MessageChangedEventV1 = MessageChangedEventV1(
            type = RoomEventType.MESSAGE_CHANGED.value,
            version = 1,
            eventId = eventId,
            room = room,
            chatId = chatId,
            messageId = messageId,
            sequence = sequence,
            senderId = senderId,
            body = body,
            createdAt = createdAt,
            messageVersion = messageVersion,
            editedAt = editedAt,
            deletedAt = deletedAt,
            replyToMessageId = replyToMessageId,
            replySenderId = replySenderId,
            replyBody = replyBody,
            replyDeleted = replyDeleted,
            replyVersion = replyVersion,
            seq = seq,
        )
    }
}
