package com.andrewtinyakov.messenger.message.change.model

data class MutationCursor(
    val revision: Long,
    val floor: Long,
)
