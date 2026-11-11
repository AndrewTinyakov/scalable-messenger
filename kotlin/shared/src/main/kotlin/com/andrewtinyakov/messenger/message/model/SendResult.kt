package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason

data class SendResult(
    val senderId: UserId,
    val requestId: RequestId,
    val chatId: ChatId?,
    val recipientId: UserId?,
    val fingerprint: String,
    val status: SendResultStatus,
    val messageId: MessageId?,
    val sequence: Long?,
    val reason: SendRejectionReason?,
) {
    init {
        require(chatId != null || recipientId != null) { "Send result must have a target" }
        when (status) {
            SendResultStatus.SAVED -> {
                require(messageId != null && sequence != null && sequence > 0 && reason == null) {
                    "Saved result must have a message and positive sequence without a rejection reason"
                }
            }

            SendResultStatus.REJECTED -> {
                require(messageId == null && sequence == null && reason != null) {
                    "Rejected result must have a rejection reason without a message or sequence"
                }
            }
        }
    }
}
