package com.andrewtinyakov.messenger.chat.model

import java.time.OffsetDateTime

data class MemberChat(
    val chat: Chat,
    val activityAt: OffsetDateTime,
)
