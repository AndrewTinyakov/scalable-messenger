package com.andrewtinyakov.messenger.message.model.change

data class MutationCursor(
    val revision: Long,
    val floor: Long,
)
