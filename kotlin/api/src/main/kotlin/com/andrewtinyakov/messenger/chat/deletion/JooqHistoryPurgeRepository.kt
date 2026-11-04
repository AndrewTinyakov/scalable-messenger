package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HISTORY_PURGE_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.VISIBILITY_CLEANUP_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.Clock
import java.time.OffsetDateTime

@Repository
class JooqHistoryPurgeRepository(
    private val db: DSLContext,
    private val clock: Clock,
) : HistoryPurgeRepository {
    override fun purge(limit: Int): Int? = DatabaseObservation.query(DatabaseOperation.DELETION_PURGE_BATCH) {
        require(limit in 1..1000)
        val chatId = db.select(CHATS.ID).from(CHATS).join(HISTORY_PURGE_JOBS).on(HISTORY_PURGE_JOBS.CHAT_ID.eq(CHATS.ID))
            .orderBy(HISTORY_PURGE_JOBS.UPDATED_AT, CHATS.ID).limit(1).forNoKeyUpdate().of(CHATS).skipLocked().fetchOne(CHATS.ID)
            ?: return@query null
        val through = db.select(
            HISTORY_PURGE_JOBS.THROUGH_SEQUENCE,
        ).from(HISTORY_PURGE_JOBS).where(HISTORY_PURGE_JOBS.CHAT_ID.eq(chatId)).fetchOne(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE)!!
        val candidates = db.select(
            MESSAGES.ID,
            MESSAGES.SEQUENCE,
        ).from(MESSAGES).where(MESSAGES.CHAT_ID.eq(chatId), MESSAGES.SEQUENCE.le(through))
            .orderBy(MESSAGES.SEQUENCE).limit(limit).fetch()
        val ids = candidates.map { it.value1()!! }
        val progress = candidates.lastOrNull()?.value2()
        if (progress !=
            null
        ) {
            db.update(
                CHATS,
            ).set(
                CHATS.PURGED_THROUGH_SEQUENCE,
                DSL.greatest(CHATS.PURGED_THROUGH_SEQUENCE, DSL.`val`(progress)),
            ).where(CHATS.ID.eq(chatId)).execute()
        }
        val removed = if (ids.isEmpty()) 0 else db.deleteFrom(MESSAGES).where(MESSAGES.ID.`in`(ids)).execute()
        db.update(CHATS).set(CHATS.PURGED_ROWS, CHATS.PURGED_ROWS.plus(removed.toLong())).where(CHATS.ID.eq(chatId)).execute()
        val obsolete = db.select(HIDDEN_MESSAGE_RANGES.USER_ID, HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE).from(HIDDEN_MESSAGE_RANGES)
            .where(HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId), HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE.le(through))
            .orderBy(
                HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE,
                HIDDEN_MESSAGE_RANGES.USER_ID,
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE,
            ).limit(limit).fetch()
        if (obsolete.isNotEmpty()) {
            db.deleteFrom(HIDDEN_MESSAGE_RANGES).where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId),
                DSL.row(HIDDEN_MESSAGE_RANGES.USER_ID, HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE).`in`(obsolete),
            ).execute()
        }
        if (ids.size < limit) {
            db.update(
                CHATS,
            ).set(
                CHATS.PURGED_THROUGH_SEQUENCE,
                DSL.greatest(CHATS.PURGED_THROUGH_SEQUENCE, DSL.`val`(through)),
            ).where(CHATS.ID.eq(chatId)).execute()
            if (obsolete.size < limit) {
                db.deleteFrom(HISTORY_PURGE_JOBS).where(HISTORY_PURGE_JOBS.CHAT_ID.eq(chatId)).execute()
            } else {
                db.update(
                    HISTORY_PURGE_JOBS,
                ).set(HISTORY_PURGE_JOBS.UPDATED_AT, OffsetDateTime.now(clock)).where(HISTORY_PURGE_JOBS.CHAT_ID.eq(chatId)).execute()
            }
        } else {
            db.update(
                HISTORY_PURGE_JOBS,
            ).set(HISTORY_PURGE_JOBS.UPDATED_AT, OffsetDateTime.now(clock)).where(HISTORY_PURGE_JOBS.CHAT_ID.eq(chatId)).execute()
        }
        return@query removed
    }

    override fun cleanupPersonal(limit: Int): Int? = DatabaseObservation.query(DatabaseOperation.DELETION_PERSONAL_CLEANUP) {
        require(limit in 1..1000)
        val job =
            db.selectFrom(
                VISIBILITY_CLEANUP_JOBS,
            ).orderBy(VISIBILITY_CLEANUP_JOBS.UPDATED_AT, VISIBILITY_CLEANUP_JOBS.CHAT_ID, VISIBILITY_CLEANUP_JOBS.USER_ID)
                .limit(1).forUpdate().skipLocked().fetchOne() ?: return@query null
        val candidates = db.select(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE).from(HIDDEN_MESSAGE_RANGES)
            .where(
                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(job.chatId),
                HIDDEN_MESSAGE_RANGES.USER_ID.eq(job.userId),
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.lt(job.throughSequence),
            )
            .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE).limit(limit).fetch(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE)
        val removed = if (candidates.isEmpty()) {
            0
        } else {
            db.deleteFrom(HIDDEN_MESSAGE_RANGES)
                .where(
                    HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(job.chatId),
                    HIDDEN_MESSAGE_RANGES.USER_ID.eq(job.userId),
                    HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.`in`(candidates),
                )
                .and(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE.le(job.throughSequence)).execute()
        }
        db.deleteFrom(
            VISIBILITY_CLEANUP_JOBS,
        ).where(VISIBILITY_CLEANUP_JOBS.CHAT_ID.eq(job.chatId), VISIBILITY_CLEANUP_JOBS.USER_ID.eq(job.userId))
            .and(if (candidates.size < limit) DSL.trueCondition() else DSL.falseCondition()).execute()
        if (candidates.size == limit) {
            db.update(VISIBILITY_CLEANUP_JOBS).set(VISIBILITY_CLEANUP_JOBS.UPDATED_AT, OffsetDateTime.now(clock))
                .where(VISIBILITY_CLEANUP_JOBS.CHAT_ID.eq(job.chatId), VISIBILITY_CLEANUP_JOBS.USER_ID.eq(job.userId)).execute()
        }
        return@query removed
    }

    override fun backlog(): PurgeBacklog = DatabaseObservation.query(DatabaseOperation.DELETION_PURGE_BACKLOG) {
        val rows = db.select(
            HISTORY_PURGE_JOBS.CREATED_AT,
        ).from(HISTORY_PURGE_JOBS).orderBy(HISTORY_PURGE_JOBS.CREATED_AT, HISTORY_PURGE_JOBS.CHAT_ID)
            .limit(10001).fetch(HISTORY_PURGE_JOBS.CREATED_AT)
        return@query PurgeBacklog(rows.size, rows.firstOrNull())
    }
}
