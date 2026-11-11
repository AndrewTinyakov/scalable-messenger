package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import java.nio.charset.StandardCharsets
import java.time.OffsetDateTime
import java.util.Base64

private const val MAX_ENCODED_LENGTH = 256

internal data class ChatCursor(
    val activityAt: OffsetDateTime,
    val chatId: ChatId,
) {
    fun encode(): String =
        Base64.getUrlEncoder().withoutPadding().encodeToString("$activityAt|${chatId.value}".toByteArray(StandardCharsets.UTF_8))

    companion object {
        fun decode(value: String): ChatCursor {
            if (value.length > MAX_ENCODED_LENGTH) invalid()
            return runCatching {
                val parts = String(Base64.getUrlDecoder().decode(value), StandardCharsets.UTF_8).split('|')
                require(parts.size == 2)
                ChatCursor(OffsetDateTime.parse(parts[0]), ChatId.parse(parts[1]))
            }.getOrElse { invalid() }
        }

        private fun invalid(): Nothing = badRequest(ApiErrorCode.INVALID_SEQUENCE, "Invalid chat cursor")
    }
}
