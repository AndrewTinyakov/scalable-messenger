package com.andrewtinyakov.messenger.chat.model

import java.time.OffsetDateTime

sealed interface MuteEnd {
    data object Forever : MuteEnd

    data class At(
        val until: OffsetDateTime,
    ) : MuteEnd

    companion object {
        const val MIN_DURATION_SECONDS = 60L
        const val MAX_DURATION_SECONDS = 366L * 24 * 60 * 60
    }
}
