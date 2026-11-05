package com.andrewtinyakov.messenger.generated.messaging.command


data class SendMessageCommandV1(
    val version: Int,
    val chatId: String? = null,
    val recipientId: String? = null,
    val requestId: String,
    val senderId: String,
    val body: String,
    val sentAt: java.time.OffsetDateTime,
    val replyToMessageId: String? = null,
    val forwardFromChatId: String? = null,
    val forwardFromMessageId: String? = null,
) {
    init {
        require(version == 1)
    }

    companion object {
        fun create(
            chatId: String? = null,
            recipientId: String? = null,
            requestId: String,
            senderId: String,
            body: String,
            sentAt: java.time.OffsetDateTime,
            replyToMessageId: String? = null,
            forwardFromChatId: String? = null,
            forwardFromMessageId: String? = null,
        ): SendMessageCommandV1 = SendMessageCommandV1(
            version = 1,
            chatId = chatId,
            recipientId = recipientId,
            requestId = requestId,
            senderId = senderId,
            body = body,
            sentAt = sentAt,
            replyToMessageId = replyToMessageId,
            forwardFromChatId = forwardFromChatId,
            forwardFromMessageId = forwardFromMessageId,
        )
    }
}
