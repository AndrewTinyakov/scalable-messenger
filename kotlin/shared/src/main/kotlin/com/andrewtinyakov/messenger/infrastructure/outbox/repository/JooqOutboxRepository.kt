package com.andrewtinyakov.messenger.infrastructure.outbox.repository

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import org.jooq.DSLContext
import org.jooq.JSONB
import org.springframework.stereotype.Repository

@Repository
class JooqOutboxRepository(
    private val db: DSLContext,
) : OutboxRepository {
    override fun enqueue(messages: Collection<OutboxMessage>) = DatabaseObservation.query(DatabaseOperation.OUTBOX_ENQUEUE) {
        if (messages.isEmpty()) return@query
        messages.chunked(500).forEach { chunk ->
            val insert = db.insertInto(
                MESSENGER_OUTBOX_EVENTS,
                MESSENGER_OUTBOX_EVENTS.ID,
                MESSENGER_OUTBOX_EVENTS.ROOM,
                MESSENGER_OUTBOX_EVENTS.PAYLOAD,
            )
            chunk.forEach { message ->
                insert.values(message.id.value, message.room, JSONB.valueOf(message.payload))
            }
            val inserted = insert.execute()
            check(inserted == chunk.size) { "Expected to enqueue ${chunk.size} outbox events, inserted $inserted" }
        }
    }
}
