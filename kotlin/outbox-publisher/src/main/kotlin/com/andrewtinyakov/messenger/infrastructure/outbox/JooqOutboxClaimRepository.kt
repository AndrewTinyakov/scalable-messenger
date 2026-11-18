package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.RoomKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.MessengerOutboxEventsRecord
import com.andrewtinyakov.messenger.infrastructure.outbox.backlog.OutboxBacklog
import org.jooq.CommonTableExpression
import org.jooq.DSLContext
import org.jooq.Record1
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqOutboxClaimRepository(
    private val db: DSLContext,
) : OutboxClaimRepository {
    override fun claim(
        now: OffsetDateTime,
        limit: Int,
        owner: String,
        leaseUntil: OffsetDateTime,
    ): List<OutboxMessage> {
        val earlier = MESSENGER_OUTBOX_EVENTS.`as`("earlier")
        val nextGroupEvent = DSL.notExists(
            DSL.selectOne().from(earlier).where(
                earlier.ROOM.eq(MESSENGER_OUTBOX_EVENTS.ROOM),
                earlier.PUBLICATION_ORDER.lt(MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER),
                earlier.PUBLISHED_AT.isNull,
            ),
        )
        val picked = DSL.name("picked").`as`(
            db.select(MESSENGER_OUTBOX_EVENTS.ID).from(MESSENGER_OUTBOX_EVENTS)
                .where(
                    MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull,
                    MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL.isNull.or(MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL.lt(now)),
                    MESSENGER_OUTBOX_EVENTS.ROOM_KIND.eq(RoomKind.USER).or(nextGroupEvent),
                ).orderBy(MESSENGER_OUTBOX_EVENTS.CREATED_AT, MESSENGER_OUTBOX_EVENTS.ID)
                .limit(limit)
                .forUpdate()
                .skipLocked(),
        )
        return lease(picked, owner, leaseUntil).sortedWith(compareBy({ it.createdAt }, { it.id })).map { it.toModel() }
    }

    override fun claimGroupTail(
        anchor: OutboxMessage,
        now: OffsetDateTime,
        limit: Int,
        owner: String,
        leaseUntil: OffsetDateTime,
    ): List<OutboxMessage> {
        if (limit <= 0 || anchor.groupPublicationOrder == null) return emptyList()
        val head = db.selectFrom(MESSENGER_OUTBOX_EVENTS)
            .where(MESSENGER_OUTBOX_EVENTS.ROOM.eq(anchor.room), MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull)
            .orderBy(MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER)
            .limit(1).forUpdate().skipLocked().fetchOne() ?: return emptyList()
        if (head.id != anchor.id.value || head.roomKind != RoomKind.GROUP || head.leaseOwner != owner ||
            head.leaseUntil == null || !head.leaseUntil!!.isAfter(now) || !leaseUntil.isAfter(now)
        ) {
            return emptyList()
        }
        val earlier = MESSENGER_OUTBOX_EVENTS.`as`("earlier")
        val unavailableEarlier = DSL.exists(
            DSL.selectOne().from(earlier).where(
                earlier.ROOM.eq(anchor.room),
                earlier.PUBLISHED_AT.isNull,
                earlier.PUBLICATION_ORDER.gt(head.publicationOrder),
                earlier.PUBLICATION_ORDER.lt(MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER),
                earlier.LEASE_UNTIL.ge(now),
            ),
        )
        val picked = DSL.name("picked").`as`(
            db.select(MESSENGER_OUTBOX_EVENTS.ID).from(MESSENGER_OUTBOX_EVENTS)
                .where(
                    MESSENGER_OUTBOX_EVENTS.ROOM.eq(anchor.room),
                    MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull,
                    MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER.gt(head.publicationOrder),
                    MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL.isNull.or(MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL.lt(now)),
                    unavailableEarlier.not(),
                ).orderBy(MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER).limit(limit).forUpdate(),
        )
        return lease(picked, owner, minOf(leaseUntil, head.leaseUntil!!)).sortedBy { it.publicationOrder }.map { it.toModel() }
    }

    private fun lease(
        picked: CommonTableExpression<Record1<String>>,
        owner: String,
        leaseUntil: OffsetDateTime,
    ): List<MessengerOutboxEventsRecord> =
        db.with(picked).update(MESSENGER_OUTBOX_EVENTS)
            .set(MESSENGER_OUTBOX_EVENTS.LEASE_OWNER, owner)
            .set(MESSENGER_OUTBOX_EVENTS.LEASE_UNTIL, leaseUntil)
            .set(MESSENGER_OUTBOX_EVENTS.ATTEMPTS, MESSENGER_OUTBOX_EVENTS.ATTEMPTS.plus(1))
            .from(picked)
            .where(MESSENGER_OUTBOX_EVENTS.ID.eq(picked.field(MESSENGER_OUTBOX_EVENTS.ID)!!))
            .returning(
                MESSENGER_OUTBOX_EVENTS.ID,
                MESSENGER_OUTBOX_EVENTS.ROOM,
                MESSENGER_OUTBOX_EVENTS.PAYLOAD,
                MESSENGER_OUTBOX_EVENTS.CREATED_AT,
                MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER,
                MESSENGER_OUTBOX_EVENTS.ROOM_KIND,
            )
            .fetch()

    override fun complete(ids: Collection<EventId>, owner: String) {
        if (ids.isEmpty()) return
        val updated = db.deleteFrom(MESSENGER_OUTBOX_EVENTS)
            .where(
                MESSENGER_OUTBOX_EVENTS.ID.`in`(ids.map(EventId::value)),
                MESSENGER_OUTBOX_EVENTS.LEASE_OWNER.eq(owner),
                MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull,
            ).execute()
        check(updated == ids.size) { "Expected to complete ${ids.size} outbox events, completed $updated" }
    }

    override fun backlog(): OutboxBacklog {
        val row = db.select(DSL.count(), DSL.min(MESSENGER_OUTBOX_EVENTS.CREATED_AT))
            .from(MESSENGER_OUTBOX_EVENTS)
            .where(MESSENGER_OUTBOX_EVENTS.PUBLISHED_AT.isNull)
            .fetchSingle()
        return OutboxBacklog(pending = row.value1().toLong(), oldestCreatedAt = row.value2())
    }
}

private fun MessengerOutboxEventsRecord.toModel(): OutboxMessage =
    OutboxMessage(
        id = EventId(id!!),
        room = room!!,
        payload = payload!!.data(),
        groupPublicationOrder = if (roomKind == RoomKind.GROUP) publicationOrder else null,
        createdAt = createdAt,
    )
