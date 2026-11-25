package com.andrewtinyakov.messenger.message.model.change

data class MessageChangePage(
    val changes: List<MessageChange>,
    val nextSeq: Long,
)
