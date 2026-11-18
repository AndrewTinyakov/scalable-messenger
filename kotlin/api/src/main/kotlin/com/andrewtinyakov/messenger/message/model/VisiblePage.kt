package com.andrewtinyakov.messenger.message.model

data class VisiblePage(
    val messages: List<Message>,
    val next: Long,
    val hasMore: Boolean,
    val after: Long,
    val through: Long,
)
