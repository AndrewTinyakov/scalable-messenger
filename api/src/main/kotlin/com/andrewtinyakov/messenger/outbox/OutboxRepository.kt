package com.andrewtinyakov.messenger.outbox

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.OUTBOX_EVENTS
import org.jooq.DSLContext
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

interface OutboxRepository {
    fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<PendingEvent>

    fun complete(id: String, owner: String, now: OffsetDateTime): Boolean
}

@Repository
class JooqOutboxRepository(
    private val db: DSLContext,
) : OutboxRepository {
    override fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<PendingEvent> {
        val rows = db.selectFrom(OUTBOX_EVENTS)
            .where(
                OUTBOX_EVENTS.PUBLISHED_AT.isNull,
                OUTBOX_EVENTS.LEASE_UNTIL.isNull.or(OUTBOX_EVENTS.LEASE_UNTIL.lt(now)),
            ).orderBy(OUTBOX_EVENTS.CREATED_AT, OUTBOX_EVENTS.ID)
            .limit(limit)
            .forUpdate()
            .skipLocked()
            .fetch()
        return rows.map { row ->
            check(
                db.update(OUTBOX_EVENTS)
                    .set(OUTBOX_EVENTS.LEASE_OWNER, owner)
                    .set(OUTBOX_EVENTS.LEASE_UNTIL, leaseUntil)
                    .set(OUTBOX_EVENTS.ATTEMPTS, OUTBOX_EVENTS.ATTEMPTS.plus(1))
                    .where(OUTBOX_EVENTS.ID.eq(row.id))
                    .execute() == 1,
            )
            PendingEvent(row.id!!, row.room!!, row.payload!!.data())
        }
    }

    override fun complete(id: String, owner: String, now: OffsetDateTime): Boolean =
        db.update(OUTBOX_EVENTS)
            .set(OUTBOX_EVENTS.PUBLISHED_AT, now)
            .setNull(OUTBOX_EVENTS.LEASE_OWNER)
            .setNull(OUTBOX_EVENTS.LEASE_UNTIL)
            .where(
                OUTBOX_EVENTS.ID.eq(id),
                OUTBOX_EVENTS.LEASE_OWNER.eq(owner),
                OUTBOX_EVENTS.PUBLISHED_AT.isNull,
            ).execute() == 1
}
