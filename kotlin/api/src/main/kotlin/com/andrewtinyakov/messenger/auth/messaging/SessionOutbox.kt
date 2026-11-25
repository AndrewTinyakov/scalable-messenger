package com.andrewtinyakov.messenger.auth.messaging

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.generated.messaging.event.SessionRevokedEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.infrastructure.outbox.toOutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.newId
import org.springframework.stereotype.Component
import tools.jackson.databind.ObjectMapper

@Component
class SessionOutbox(
    private val outboxRepository: OutboxRepository,
    private val mapper: ObjectMapper,
) {
    fun enqueueRevoked(
        userId: UserId,
        sessionIds: Collection<SessionId>,
    ) {
        if (sessionIds.isEmpty()) return
        val room = RoomAddress.user(userId)
        outboxRepository.enqueue(
            sessionIds.map { sessionId ->
                SessionRevokedEventV1.create(
                    eventId = newId(),
                    room = room,
                    sessionId = sessionId.value,
                ).toOutboxMessage(mapper)
            },
        )
    }
}
