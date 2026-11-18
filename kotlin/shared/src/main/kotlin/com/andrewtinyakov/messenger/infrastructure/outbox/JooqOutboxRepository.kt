package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import org.jooq.DSLContext
import org.jooq.JSONB
import org.springframework.stereotype.Repository

private const val INSERT_CHUNK_SIZE = 500

@Repository
class JooqOutboxRepository(
    private val db: DSLContext,
) : OutboxRepository {
    override fun enqueue(messages: Collection<OutboxMessage>) {
        if (messages.isEmpty()) return
        messages.chunked(INSERT_CHUNK_SIZE).forEach { chunk ->
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
