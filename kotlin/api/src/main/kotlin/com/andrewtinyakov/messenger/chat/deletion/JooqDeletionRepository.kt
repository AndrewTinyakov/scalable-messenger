package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.DELETION_OPERATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HISTORY_PURGE_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_CHANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.VISIBILITY_CLEANUP_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.message.visibility.visibleMessage
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.Clock
import java.time.OffsetDateTime

@Repository
class JooqDeletionRepository(
    private val db: DSLContext,
    private val clock: Clock,
) : DeletionRepository {
    override fun lockRequest(actorId: UserId, requestId: String) = DatabaseObservation.query(DatabaseOperation.DELETION_REQUEST_LOCK) {
        Routines.acquireTransactionLock(db.configuration(), "deletion:${actorId.value}:$requestId")
    }

    override fun operation(chatId: ChatId, actorId: UserId, requestId: String): StoredDeletion? = DatabaseObservation.query(
        DatabaseOperation.DELETION_OPERATION_STATUS,
    ) {
        db.select(DELETION_OPERATIONS.asterisk(), CHATS.PURGED_THROUGH_SEQUENCE, CHATS.PURGED_ROWS)
            .from(DELETION_OPERATIONS).join(CHATS).on(CHATS.ID.eq(DELETION_OPERATIONS.CHAT_ID))
            .where(DELETION_OPERATIONS.ACTOR_ID.eq(actorId.value), DELETION_OPERATIONS.REQUEST_ID.eq(requestId))
            .fetchOne { row ->
                val stored = row.into(DELETION_OPERATIONS)
                val prefix = stored.scope == "EVERYONE" && stored.target != "MESSAGES"
                val complete = !prefix || row.get(CHATS.PURGED_THROUGH_SEQUENCE)!! >= stored.throughSequence!!
                val deletedRows = if (prefix) maxOf(0L, row.get(CHATS.PURGED_ROWS)!! - stored.purgeRowsBefore!!) else stored.deletedRows!!
                StoredDeletion(
                    stored.chatId!!,
                    stored.fingerprint!!,
                    DeletionResponse(
                        stored.requestId!!,
                        DeletionScope.valueOf(stored.scope!!),
                        DeletionTarget.valueOf(stored.target!!),
                        stored.throughSequence!!.toString(),
                        stored.mutationRevision!!.toString(),
                        stored.visibilityRevision!!.toString(),
                        if (complete) DeletionState.COMPLETED else DeletionState.ACCEPTED,
                        deletedRows.toString(),
                    ),
                )
            }
    }

    override fun targets(chatId: ChatId, actorId: UserId, ids: List<MessageId>, scope: DeletionScope): List<DeletionMessage> =
        DatabaseObservation.query(DatabaseOperation.DELETION_TARGETS) {
            require(ids.size <= 100)
            if (ids.isEmpty()) return@query emptyList()
            db.select(MESSAGES.ID, MESSAGES.SEQUENCE, MESSAGES.SENDER_ID, MESSAGES.MESSAGE_VERSION).from(MESSAGES)
                .join(CHATS).on(CHATS.ID.eq(MESSAGES.CHAT_ID)).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
                .where(
                    MESSAGES.CHAT_ID.eq(chatId.value),
                    CHAT_MEMBERS.USER_ID.eq(actorId.value),
                    CHATS.DELETED_AT.isNull,
                    MESSAGES.ID.`in`(ids.map { it.value }),
                    MESSAGES.SEQUENCE.gt(CHATS.CLEARED_THROUGH_SEQUENCE),
                )
                .and(if (scope == DeletionScope.SELF) visibleMessage(chatId, actorId, MESSAGES.SEQUENCE) else DSL.trueCondition())
                .fetch { DeletionMessage(MessageId(it.value1()!!), it.value2()!!, UserId(it.value3()!!), it.value4()!!) }
        }

    override fun lockChat(chatId: ChatId, actorId: UserId): DeletionChat? = DatabaseObservation.query(
        DatabaseOperation.DELETION_CHAT_LOCK,
    ) {
        db.select(CHATS.asterisk(), CHAT_MEMBERS.VISIBILITY_REVISION)
            .from(CHATS).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .where(CHATS.ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(actorId.value))
            .forNoKeyUpdate().of(CHATS).fetchOne {
                val chat = it.into(CHATS)
                DeletionChat(
                    ChatKind.valueOf(chat.kind!!.name),
                    chat.ownerId?.let(::UserId),
                    chat.nextSequence!! - 1,
                    chat.mutationRevision!!,
                    it.get(CHAT_MEMBERS.VISIBILITY_REVISION)!!,
                    chat.purgedRows!!,
                    chat.deletedAt != null,
                )
            }
    }

    override fun hideMessages(chatId: ChatId, actorId: UserId, messages: List<DeletionMessage>): Long = DatabaseObservation.query(
        DatabaseOperation.DELETION_PERSONAL_MESSAGES,
    ) {
        db.selectFrom(
            CHAT_MEMBERS,
        ).where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(actorId.value)).forUpdate().fetchOne()!!
        for (message in messages.sortedBy { it.sequence }) {
            var after = message.sequence - 1
            var through = message.sequence
            val base = HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value).and(HIDDEN_MESSAGE_RANGES.USER_ID.eq(actorId.value))
            val left = db.selectFrom(HIDDEN_MESSAGE_RANGES).where(base, HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.le(after))
                .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1).fetchOne()?.takeIf { it.throughSequence!! >= after }
            val right = db.selectFrom(HIDDEN_MESSAGE_RANGES).where(base, HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.eq(through)).fetchOne()
            val touching = listOfNotNull(left, right).distinctBy { it.afterSequence }
            if (touching.isNotEmpty()) {
                after = minOf(after, touching.minOf { it.afterSequence!! })
                through = maxOf(through, touching.maxOf { it.throughSequence!! })
                db.deleteFrom(HIDDEN_MESSAGE_RANGES).where(
                    HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                    HIDDEN_MESSAGE_RANGES.USER_ID.eq(actorId.value),
                    HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.`in`(
                        touching.map {
                            it.afterSequence
                        },
                    ),
                ).execute()
            }
            db.insertInto(
                HIDDEN_MESSAGE_RANGES,
            ).set(HIDDEN_MESSAGE_RANGES.CHAT_ID, chatId.value).set(HIDDEN_MESSAGE_RANGES.USER_ID, actorId.value)
                .set(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE, after).set(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE, through).execute()
        }
        return@query advanceVisibility(chatId, actorId)
    }

    override fun clearPersonal(chatId: ChatId, actorId: UserId, through: Long, hide: Boolean): Long = DatabaseObservation.query(
        DatabaseOperation.DELETION_PERSONAL_CLEAR,
    ) {
        db.update(
            CHAT_MEMBERS,
        ).set(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE, DSL.greatest(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE, DSL.`val`(through)))
            .set(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE, if (hide) through else null)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(actorId.value)).execute()
        db.insertInto(
            VISIBILITY_CLEANUP_JOBS,
        ).set(VISIBILITY_CLEANUP_JOBS.CHAT_ID, chatId.value).set(VISIBILITY_CLEANUP_JOBS.USER_ID, actorId.value)
            .set(
                VISIBILITY_CLEANUP_JOBS.THROUGH_SEQUENCE,
                through,
            ).onConflict(VISIBILITY_CLEANUP_JOBS.CHAT_ID, VISIBILITY_CLEANUP_JOBS.USER_ID)
            .doUpdate().set(
                VISIBILITY_CLEANUP_JOBS.THROUGH_SEQUENCE,
                DSL.greatest(VISIBILITY_CLEANUP_JOBS.THROUGH_SEQUENCE, DSL.`val`(through)),
            ).execute()
        return@query advanceVisibility(chatId, actorId)
    }

    private fun advanceVisibility(chatId: ChatId, actorId: UserId): Long = db.update(CHAT_MEMBERS)
        .set(CHAT_MEMBERS.VISIBILITY_REVISION, CHAT_MEMBERS.VISIBILITY_REVISION.plus(1L))
        .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(actorId.value))
        .returning(CHAT_MEMBERS.VISIBILITY_REVISION).fetchOne()!!.visibilityRevision!!

    override fun removeMessages(chatId: ChatId, messages: List<DeletionMessage>): Long = DatabaseObservation.query(
        DatabaseOperation.DELETION_GLOBAL_MESSAGES,
    ) {
        var revision = db.select(CHATS.MUTATION_REVISION).from(CHATS).where(CHATS.ID.eq(chatId.value)).fetchOne(CHATS.MUTATION_REVISION)!!
        for (message in messages) {
            revision = nextRevision(chatId)
            db.insertInto(MESSAGE_CHANGES).set(MESSAGE_CHANGES.CHAT_ID, chatId.value).set(MESSAGE_CHANGES.REVISION, revision)
                .set(
                    MESSAGE_CHANGES.KIND,
                    "REMOVED",
                ).set(MESSAGE_CHANGES.MESSAGE_ID, message.id.value).set(MESSAGE_CHANGES.SEQUENCE, message.sequence)
                .set(MESSAGE_CHANGES.CHANGED_AT, OffsetDateTime.now(clock)).execute()
        }
        if (messages.isNotEmpty()) {
            db.deleteFrom(MESSAGES).where(
                MESSAGES.CHAT_ID.eq(chatId.value),
                MESSAGES.ID.`in`(
                    messages.map {
                        it.id.value
                    },
                ),
            ).execute()
        }
        return@query revision
    }

    override fun repairClosedPurge(chatId: ChatId, through: Long) = DatabaseObservation.query(DatabaseOperation.DELETION_GLOBAL_CLEAR) {
        db.update(CHATS).set(CHATS.CLEARED_THROUGH_SEQUENCE, DSL.greatest(CHATS.CLEARED_THROUGH_SEQUENCE, DSL.`val`(through)))
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNotNull, CHATS.CLEARED_THROUGH_SEQUENCE.lt(through)).execute()
        db.insertInto(HISTORY_PURGE_JOBS, HISTORY_PURGE_JOBS.CHAT_ID, HISTORY_PURGE_JOBS.THROUGH_SEQUENCE)
            .select(
                db.select(CHATS.ID, CHATS.CLEARED_THROUGH_SEQUENCE).from(CHATS)
                    .where(
                        CHATS.ID.eq(chatId.value),
                        CHATS.DELETED_AT.isNotNull,
                        CHATS.PURGED_THROUGH_SEQUENCE.lt(CHATS.CLEARED_THROUGH_SEQUENCE),
                    ),
            )
            .onConflict(HISTORY_PURGE_JOBS.CHAT_ID).doUpdate()
            .set(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, DSL.greatest(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, DSL.`val`(through))).execute()
        Unit
    }

    override fun clearGlobal(chatId: ChatId, actorId: UserId, through: Long, close: Boolean): Long = DatabaseObservation.query(
        DatabaseOperation.DELETION_GLOBAL_CLEAR,
    ) {
        val now = OffsetDateTime.now(clock)
        db.update(CHATS).set(CHATS.CLEARED_THROUGH_SEQUENCE, DSL.greatest(CHATS.CLEARED_THROUGH_SEQUENCE, DSL.`val`(through)))
            .where(CHATS.ID.eq(chatId.value)).execute()
        if (close) {
            db.update(
                CHATS,
            ).set(
                CHATS.DELETED_AT,
                now,
            ).set(CHATS.DELETED_BY, actorId.value).setNull(CHATS.DIRECT_PAIR_KEY).where(CHATS.ID.eq(chatId.value)).execute()
        }
        val revision = nextRevision(chatId)
        db.insertInto(MESSAGE_CHANGES).set(MESSAGE_CHANGES.CHAT_ID, chatId.value).set(MESSAGE_CHANGES.REVISION, revision)
            .set(
                MESSAGE_CHANGES.KIND,
                "CLEARED",
            ).set(MESSAGE_CHANGES.CLEARED_THROUGH_SEQUENCE, through).set(MESSAGE_CHANGES.CHANGED_AT, now).execute()
        db.insertInto(HISTORY_PURGE_JOBS).set(HISTORY_PURGE_JOBS.CHAT_ID, chatId.value).set(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, through)
            .onConflict(
                HISTORY_PURGE_JOBS.CHAT_ID,
            ).doUpdate().set(
                HISTORY_PURGE_JOBS.THROUGH_SEQUENCE,
                DSL.greatest(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, DSL.`val`(through)),
            ).execute()
        return@query revision
    }

    private fun nextRevision(chatId: ChatId): Long = db.update(CHATS).set(CHATS.MUTATION_REVISION, CHATS.MUTATION_REVISION.plus(1L))
        .where(CHATS.ID.eq(chatId.value)).returning(CHATS.MUTATION_REVISION).fetchOne()!!.mutationRevision!!

    override fun saveOperation(
        chatId: ChatId,
        actorId: UserId,
        request: DeletionRequest,
        fingerprint: String,
        chat: DeletionChat,
        revision: Long,
        visibility: Long,
        rows: Int,
    ) = DatabaseObservation.query(
        DatabaseOperation.DELETION_OPERATION_SAVE,
    ) {
        db.insertInto(
            DELETION_OPERATIONS,
        ).set(DELETION_OPERATIONS.ACTOR_ID, actorId.value).set(DELETION_OPERATIONS.REQUEST_ID, request.requestId)
            .set(
                DELETION_OPERATIONS.CHAT_ID,
                chatId.value,
            ).set(DELETION_OPERATIONS.FINGERPRINT, fingerprint).set(DELETION_OPERATIONS.SCOPE, request.scope.name)
            .set(DELETION_OPERATIONS.TARGET, request.target.name).set(
                DELETION_OPERATIONS.THROUGH_SEQUENCE,
                if (request.target ==
                    DeletionTarget.MESSAGES
                ) {
                    0L
                } else {
                    chat.high
                },
            )
            .set(DELETION_OPERATIONS.MUTATION_REVISION, revision).set(DELETION_OPERATIONS.VISIBILITY_REVISION, visibility)
            .set(DELETION_OPERATIONS.DELETED_ROWS, rows.toLong()).set(DELETION_OPERATIONS.PURGE_ROWS_BEFORE, chat.purgedRows).execute()
        Unit
    }
}
