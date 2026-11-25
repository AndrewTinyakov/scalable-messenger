package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage

fun interface OutboxEventPublisher {
    fun publish(message: OutboxMessage)

    fun hydrate(messages: List<OutboxMessage>): List<OutboxMessage> = messages
}
