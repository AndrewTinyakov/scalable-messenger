package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test

class SendResultTests {
    private val saved = SendResult(
        senderId = UserId(newId()),
        requestId = RequestId(newId()),
        chatId = ChatId(newId()),
        recipientId = UserId(newId()),
        fingerprint = "fingerprint",
        status = SendResultStatus.SAVED,
        messageId = MessageId(newId()),
        sequence = 1,
        reason = null,
    )

    @Test
    fun `saved result retains both resolved chat and direct recipient`() {
        assertEquals(SendResultStatus.SAVED, saved.status)
        saved.copy(recipientId = null)
        saved.copy(chatId = null)
    }

    @Test
    fun `result requires a target even when copied`() {
        assertThrows(IllegalArgumentException::class.java) { saved.copy(chatId = null, recipientId = null) }
    }

    @Test
    fun `saved result requires message and positive sequence without a reason`() {
        assertThrows(IllegalArgumentException::class.java) { saved.copy(messageId = null) }
        assertThrows(IllegalArgumentException::class.java) { saved.copy(sequence = null) }
        assertThrows(IllegalArgumentException::class.java) { saved.copy(sequence = 0) }
        assertThrows(IllegalArgumentException::class.java) { saved.copy(sequence = -1) }
        assertThrows(IllegalArgumentException::class.java) { saved.copy(reason = SendRejectionReason.NOT_A_MEMBER) }
    }

    @Test
    fun `rejected result requires reason and excludes saved message fields`() {
        val rejected = saved.copy(
            status = SendResultStatus.REJECTED,
            messageId = null,
            sequence = null,
            reason = SendRejectionReason.NOT_A_MEMBER,
        )
        assertThrows(IllegalArgumentException::class.java) { rejected.copy(reason = null) }
        assertThrows(IllegalArgumentException::class.java) { rejected.copy(messageId = saved.messageId) }
        assertThrows(IllegalArgumentException::class.java) { rejected.copy(sequence = 1) }
    }
}
