package com.andrewtinyakov.messenger.message.model.change

data class MutationCursor(
    val lastSeq: Long,
    val floor: Long,
)
