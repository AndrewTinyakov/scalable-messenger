package com.andrewtinyakov.messenger.read.repository

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_NOTIFICATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_PROGRESS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.read.model.MessageReadTarget
import com.andrewtinyakov.messenger.read.model.MessageReader
import com.andrewtinyakov.messenger.read.model.ReadAdvance
import com.andrewtinyakov.messenger.read.model.ReadCleanup
import com.andrewtinyakov.messenger.read.model.ReadProgress
import com.andrewtinyakov.messenger.read.model.ReadSummary
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.web.notFound
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.Clock
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.temporal.ChronoUnit

private const val MAX_CREATION_DAY_LOOKUP_SPAN = 256L

@Repository
class JooqReadRepository(
    private val db: DSLContext,
    private val clock: Clock,
) : ReadRepository {
    private fun member(chatId: ChatId, userId: UserId) = DSL.exists(
        DSL.selectOne().from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull),
    )

    override fun requireMember(chatId: ChatId, userId: UserId): Long = DatabaseObservation.query(DatabaseOperation.READ_AUTHORIZE) {
        db.select(CHATS.NEXT_SEQUENCE).from(CHATS).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .where(CHATS.ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .forKeyShare().of(CHAT_MEMBERS).fetchOne(CHATS.NEXT_SEQUENCE)?.minus(1) ?: notFound()
    }

    override fun advance(chatId: ChatId, userId: UserId, sequence: Long): ReadAdvance =
        DatabaseObservation.query(DatabaseOperation.READ_ADVANCE) {
            db.insertInto(CHAT_READ_PROGRESS).set(CHAT_READ_PROGRESS.CHAT_ID, chatId.value)
                .set(CHAT_READ_PROGRESS.USER_ID, userId.value)
                .onConflict(CHAT_READ_PROGRESS.CHAT_ID, CHAT_READ_PROGRESS.USER_ID).doNothing().execute()
            val previous = db.selectFrom(CHAT_READ_PROGRESS).where(
                CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value),
                CHAT_READ_PROGRESS.USER_ID.eq(userId.value),
                member(chatId, userId),
            ).forUpdate().fetchOne() ?: notFound()
            if (sequence <= previous.throughSequence!!) {
                return@query ReadAdvance(ReadProgress(previous.throughSequence!!, previous.readAt), false)
            }
            val lockedAt = OffsetDateTime.now(clock).truncatedTo(ChronoUnit.MICROS)
            val acceptedAt = previous.readAt?.takeIf { it.isAfter(lockedAt) } ?: lockedAt
            val updated = db.update(CHAT_READ_PROGRESS).set(CHAT_READ_PROGRESS.THROUGH_SEQUENCE, sequence)
                .set(CHAT_READ_PROGRESS.READ_AT, acceptedAt)
                .where(CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value), CHAT_READ_PROGRESS.USER_ID.eq(userId.value), member(chatId, userId))
                .execute()
            if (updated != 1) notFound()
            val days = creationDays(chatId, previous.throughSequence!!, sequence, acceptedAt)
            val inserts = days.map { day ->
                db.insertInto(CHAT_READ_RANGES).set(CHAT_READ_RANGES.CHAT_ID, chatId.value)
                    .set(CHAT_READ_RANGES.USER_ID, userId.value).set(CHAT_READ_RANGES.CREATION_DAY, day)
                    .set(CHAT_READ_RANGES.AFTER_SEQUENCE, previous.throughSequence)
                    .set(CHAT_READ_RANGES.THROUGH_SEQUENCE, sequence).set(CHAT_READ_RANGES.READ_AT, acceptedAt)
                    .set(CHAT_READ_RANGES.EXPIRES_AT, day.plusDays(8).atStartOfDay().atOffset(ZoneOffset.UTC))
            }
            if (inserts.isNotEmpty()) check(db.batch(inserts).execute().all { it == 1 })
            ReadAdvance(ReadProgress(sequence, acceptedAt), true, inserts.size)
        }

    private fun creationDays(chatId: ChatId, after: Long, through: Long, acceptedAt: OffsetDateTime): List<LocalDate> {
        if (through - after > MAX_CREATION_DAY_LOOKUP_SPAN) {
            val today = acceptedAt.withOffsetSameInstant(ZoneOffset.UTC).toLocalDate()
            return (0L..7L).map(today::minusDays)
        }
        return DatabaseObservation.query(DatabaseOperation.READ_RANGE_DAYS) {
            val day = DSL.field("({0} AT TIME ZONE 'UTC')::date", LocalDate::class.java, MESSAGES.CREATED_AT)
            db.selectDistinct(day).from(MESSAGES).where(
                MESSAGES.CHAT_ID.eq(chatId.value),
                MESSAGES.SEQUENCE.gt(after),
                MESSAGES.SEQUENCE.le(through),
                MESSAGES.CREATED_AT.gt(acceptedAt.minusDays(7)),
                MESSAGES.CREATED_AT.le(acceptedAt),
            ).fetch(day).filterNotNull()
        }
    }

    override fun summary(chatId: ChatId, userId: UserId): ReadSummary? = DatabaseObservation.query(DatabaseOperation.READ_SUMMARY) {
        val own = DSL.select(CHAT_READ_PROGRESS.THROUGH_SEQUENCE).from(CHAT_READ_PROGRESS)
            .where(CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value), CHAT_READ_PROGRESS.USER_ID.eq(userId.value))
        val other = DSL.select(CHAT_READ_PROGRESS.THROUGH_SEQUENCE).from(CHAT_READ_PROGRESS)
            .where(
                CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value),
                CHAT_READ_PROGRESS.USER_ID.ne(userId.value),
                CHAT_READ_PROGRESS.ACTIVE_MEMBERSHIP.isTrue,
            ).orderBy(CHAT_READ_PROGRESS.THROUGH_SEQUENCE.desc()).limit(1)
        db.select(DSL.coalesce(own.asField<Long>(), DSL.inline(0L)), DSL.coalesce(other.asField<Long>(), DSL.inline(0L)))
            .where(member(chatId, userId)).fetchOne { ReadSummary(it.value1(), it.value2()) }
    }

    override fun messageTarget(chatId: ChatId, userId: UserId, messageId: MessageId): MessageReadTarget? =
        DatabaseObservation.query(DatabaseOperation.READ_DETAILS) {
            db.select(MESSAGES.SEQUENCE, MESSAGES.CREATED_AT, MESSAGES.DELETED_AT).from(MESSAGES).where(
                MESSAGES.CHAT_ID.eq(chatId.value),
                MESSAGES.ID.eq(messageId.value),
                MESSAGES.SENDER_ID.eq(userId.value),
                member(chatId, userId),
            ).fetchOne { MessageReadTarget(it.value1()!!, it.value2()!!, it.value3() != null) }
        }

    override fun readers(
        chatId: ChatId,
        userId: UserId,
        sequence: Long,
        creationDay: LocalDate,
        afterUserId: UserId?,
        limit: Int,
    ): List<MessageReader> =
        DatabaseObservation.query(DatabaseOperation.READ_DETAILS) {
            val interval = DSL.lateral(
                DSL.select(CHAT_READ_RANGES.AFTER_SEQUENCE, CHAT_READ_RANGES.READ_AT).from(CHAT_READ_RANGES)
                    .where(
                        CHAT_READ_RANGES.CHAT_ID.eq(CHAT_READ_PROGRESS.CHAT_ID),
                        CHAT_READ_RANGES.USER_ID.eq(CHAT_READ_PROGRESS.USER_ID),
                        CHAT_READ_RANGES.CREATION_DAY.eq(creationDay),
                        CHAT_READ_RANGES.THROUGH_SEQUENCE.ge(sequence),
                    )
                    .orderBy(CHAT_READ_RANGES.THROUGH_SEQUENCE).limit(1),
            ).`as`("read_interval")
            db.select(CHAT_READ_PROGRESS.USER_ID, USERS.USERNAME, interval.field(CHAT_READ_RANGES.READ_AT))
                .from(CHAT_READ_PROGRESS).join(USERS).on(USERS.ID.eq(CHAT_READ_PROGRESS.USER_ID))
                .join(
                    CHAT_MEMBERS,
                ).on(CHAT_MEMBERS.CHAT_ID.eq(CHAT_READ_PROGRESS.CHAT_ID), CHAT_MEMBERS.USER_ID.eq(CHAT_READ_PROGRESS.USER_ID))
                .join(interval).on(interval.field(CHAT_READ_RANGES.AFTER_SEQUENCE)!!.lt(sequence)).where(
                    CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value),
                    CHAT_READ_PROGRESS.USER_ID.ne(userId.value),
                    CHAT_READ_PROGRESS.THROUGH_SEQUENCE.ge(sequence),
                    member(chatId, userId),
                    afterUserId?.let { CHAT_READ_PROGRESS.USER_ID.gt(it.value) } ?: DSL.trueCondition(),
                ).orderBy(CHAT_READ_PROGRESS.USER_ID).limit(limit)
                .fetch { MessageReader(UserId(it.value1()!!), it.value2()!!, it.value3()!!) }
        }

    override fun notificationRooms(chatId: ChatId, now: OffsetDateTime): List<String> = DatabaseObservation.query(
        DatabaseOperation.READ_NOTIFY,
    ) {
        val inserted = db.insertInto(
            CHAT_READ_NOTIFICATIONS,
            CHAT_READ_NOTIFICATIONS.CHAT_ID,
            CHAT_READ_NOTIFICATIONS.BUCKET,
            CHAT_READ_NOTIFICATIONS.EXPIRES_AT,
        ).select(
            DSL.select(DSL.`val`(chatId.value), DSL.`val`(now.toEpochSecond() / 2), DSL.`val`(now.plusMinutes(2)))
                .where(DSL.condition("pg_try_advisory_xact_lock(761291005, hashtext({0}))", DSL.`val`(chatId.value))),
        ).onConflictDoNothing().execute()
        if (inserted == 0) return@query emptyList()
        val kind = db.select(CHATS.KIND).from(CHATS).where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull).fetchOne(CHATS.KIND)
        if (kind == ChatKind.GROUP) return@query listOf(RoomAddress.group(chatId))
        if (kind == null) return@query emptyList()
        db.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS).where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value)).limit(2)
            .fetch { RoomAddress.user(UserId(it.value1()!!)) }
    }

    override fun cleanup(now: OffsetDateTime, limit: Int): ReadCleanup? = DatabaseObservation.query(DatabaseOperation.READ_CLEANUP) {
        require(limit in 1..1000)
        if (db.select(DSL.field("pg_try_advisory_xact_lock(7612910046)", Boolean::class.java)).fetchOne(0, Boolean::class.java) != true) {
            return@query null
        }
        val ranges = db.select(
            CHAT_READ_RANGES.CHAT_ID,
            CHAT_READ_RANGES.USER_ID,
            CHAT_READ_RANGES.CREATION_DAY,
            CHAT_READ_RANGES.THROUGH_SEQUENCE,
        )
            .from(CHAT_READ_RANGES).where(CHAT_READ_RANGES.EXPIRES_AT.le(now))
            .orderBy(
                CHAT_READ_RANGES.EXPIRES_AT,
                CHAT_READ_RANGES.CHAT_ID,
                CHAT_READ_RANGES.USER_ID,
                CHAT_READ_RANGES.CREATION_DAY,
                CHAT_READ_RANGES.THROUGH_SEQUENCE,
            )
            .limit(limit).forUpdate().skipLocked().fetch()
        val deletedRanges = if (ranges.isEmpty()) {
            0
        } else {
            db.deleteFrom(CHAT_READ_RANGES).where(
                DSL.row(
                    CHAT_READ_RANGES.CHAT_ID,
                    CHAT_READ_RANGES.USER_ID,
                    CHAT_READ_RANGES.CREATION_DAY,
                    CHAT_READ_RANGES.THROUGH_SEQUENCE,
                ).`in`(ranges),
            ).execute()
        }
        val notifications = db.select(CHAT_READ_NOTIFICATIONS.CHAT_ID, CHAT_READ_NOTIFICATIONS.BUCKET)
            .from(CHAT_READ_NOTIFICATIONS).where(CHAT_READ_NOTIFICATIONS.EXPIRES_AT.le(now))
            .orderBy(CHAT_READ_NOTIFICATIONS.EXPIRES_AT, CHAT_READ_NOTIFICATIONS.CHAT_ID, CHAT_READ_NOTIFICATIONS.BUCKET)
            .limit(limit).forUpdate().skipLocked().fetch()
        val deletedNotifications = if (notifications.isEmpty()) {
            0
        } else {
            db.deleteFrom(CHAT_READ_NOTIFICATIONS).where(
                DSL.row(CHAT_READ_NOTIFICATIONS.CHAT_ID, CHAT_READ_NOTIFICATIONS.BUCKET).`in`(notifications),
            ).execute()
        }
        val backlog = DatabaseObservation.query(DatabaseOperation.READ_BACKLOG) {
            db.select(CHAT_READ_RANGES.EXPIRES_AT).from(CHAT_READ_RANGES).where(CHAT_READ_RANGES.EXPIRES_AT.le(now))
                .orderBy(CHAT_READ_RANGES.EXPIRES_AT).limit(10001).fetch(CHAT_READ_RANGES.EXPIRES_AT)
        }
        ReadCleanup(deletedRanges, deletedNotifications, backlog.size, backlog.firstOrNull())
    }
}
