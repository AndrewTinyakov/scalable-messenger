package com.andrewtinyakov.messenger.chat.preferences.model

import java.time.OffsetDateTime

sealed interface MuteEnd {
    data object Forever : MuteEnd

    data class At(
        val until: OffsetDateTime,
    ) : MuteEnd
}
