package com.andrewtinyakov.messenger.infrastructure.outbox

data class OutboxMessage(
    val id: String,
    val room: String,
    val payload: String,
)
