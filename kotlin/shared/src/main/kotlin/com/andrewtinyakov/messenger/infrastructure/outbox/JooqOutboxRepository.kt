package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import org.jooq.DSLContext
import org.jooq.JSONB
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqOutboxRepository(
    private val db: DSLContext,
) : OutboxRepository {
    override fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<OutboxMessage> {
        val rows = db.selectFrom(MESSENGER_OUTBOX_EVENTS)
            .where(
                MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull,
                MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL.isNull.or(MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL.lt(now)),
            ).orderBy(MESSENGER_OUTBOX_EVENTS.CREATED_AT, MESSENGER_OUTBOX_EVENTS.ID)
            .limit(limit)
            .forUpdate()
            .skipLocked()
            .fetch()
        if (rows.isEmpty()) return emptyList()
        val updated = db.update(MESSENGER_OUTBOX_EVENTS)
            .set(MESSENGER_OUTBOX_EVENTS.LEASE_OWNER, owner)
            .set(MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL, leaseUntil)
            .set(MESSENGER_OUTBOX_EVENTS.ATTEMPTS, MESSENGER_OUTBOX_EVENTS.ATTEMPTS.plus(1))
            .where(MESSENGER_OUTBOX_EVENTS.ID.`in`(rows.map { it.id!! }))
            .execute()
        check(updated == rows.size) { "Expected to claim ${rows.size} outbox events, claimed $updated" }
        return rows.map { row -> OutboxMessage(row.id!!, row.room!!, row.payload!!.data()) }
    }

    override fun complete(ids: Collection<String>, owner: String) {
        if (ids.isEmpty()) return
        val updated = db.deleteFrom(MESSENGER_OUTBOX_EVENTS)
            .where(
                MESSENGER_OUTBOX_EVENTS.ID.`in`(ids),
                MESSENGER_OUTBOX_EVENTS.LEASE_OWNER.eq(owner),
                MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull,
            ).execute()
        check(updated == ids.size) { "Expected to complete ${ids.size} outbox events, completed $updated" }
    }

    override fun enqueue(messages: Collection<OutboxMessage>) {
        if (messages.isEmpty()) return
        messages.chunked(500).forEach { chunk ->
            val insert = db.insertInto(
                MESSENGER_OUTBOX_EVENTS,
                MESSENGER_OUTBOX_EVENTS.ID,
                MESSENGER_OUTBOX_EVENTS.ROOM,
                MESSENGER_OUTBOX_EVENTS.PAYLOAD,
            )
            chunk.forEach { message ->
                insert.values(message.id, message.room, JSONB.valueOf(message.payload))
            }
            val inserted = insert.execute()
            check(inserted == chunk.size) { "Expected to enqueue ${chunk.size} outbox events, inserted $inserted" }
        }
    }
}
