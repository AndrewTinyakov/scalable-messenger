package com.andrewtinyakov.messenger.infrastructure.outbox.service

import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage

fun interface OutboxEventPublisher {
    fun publish(message: OutboxMessage)

    fun hydrate(messages: List<OutboxMessage>): List<OutboxMessage> = messages
}
