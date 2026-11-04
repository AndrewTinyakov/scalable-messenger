package com.andrewtinyakov.messenger.infrastructure.outbox

fun interface OutboxEventPublisher {
    fun publish(message: OutboxMessage)

    fun prepare(messages: List<OutboxMessage>): List<OutboxMessage> = messages
}
