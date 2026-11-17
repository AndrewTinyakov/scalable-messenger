package com.andrewtinyakov.messenger.message.model

data class MutationCursor(
    val revision: Long,
    val floor: Long,
)
