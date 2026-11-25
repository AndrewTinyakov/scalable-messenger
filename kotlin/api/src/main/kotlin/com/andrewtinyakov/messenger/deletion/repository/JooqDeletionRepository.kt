package com.andrewtinyakov.messenger.deletion.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.deletion.model.DeletionChat
import com.andrewtinyakov.messenger.deletion.model.DeletionMessage
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.model.DeletionSequences
import com.andrewtinyakov.messenger.deletion.model.DeletionState
import com.andrewtinyakov.messenger.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.deletion.model.StoredDeletion
import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.DELETION_OPERATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HISTORY_PURGE_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_CHANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_PINS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.VISIBILITY_CLEANUP_JOBS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.DeletionOperationsRecord
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.HiddenMessageRangesRecord
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.HistoryPurgeJobsRecord
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.model.change.MessageChangeKind
import com.andrewtinyakov.messenger.message.repository.visibleMessage
import org.jooq.Condition
import org.jooq.DSLContext
import org.jooq.InsertOnDuplicateStep
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.Clock
import java.time.OffsetDateTime

@Repository
class JooqDeletionRepository(
    private val db: DSLContext,
    private val clock: Clock,
) : DeletionRepository {
    override fun lockRequest(userId: UserId, requestId: RequestId) =
        Routines.acquireTransactionLock(db.configuration(), "deletion:${userId.value}:${requestId.value}")

    override fun operation(userId: UserId, requestId: RequestId): StoredDeletion? =
        db.select(DELETION_OPERATIONS.asterisk(), CHATS.PURGED_THROUGH_SEQUENCE, CHATS.PURGED_ROWS)
            .from(DELETION_OPERATIONS).join(CHATS).on(CHATS.ID.eq(DELETION_OPERATIONS.CHAT_ID))
            .where(DELETION_OPERATIONS.ACTOR_ID.eq(userId.value), DELETION_OPERATIONS.REQUEST_ID.eq(requestId.value))
            .fetchOne { row ->
                row.into(DELETION_OPERATIONS).toModel(
                    purgedThroughSequence = row.get(CHATS.PURGED_THROUGH_SEQUENCE)!!,
                    purgedRows = row.get(CHATS.PURGED_ROWS)!!,
                )
            }

    override fun targets(chatId: ChatId, userId: UserId, ids: List<MessageId>, scope: DeletionScope): List<DeletionMessage> {
        require(ids.size <= DeletionMessage.MAX_PER_REQUEST)
        if (ids.isEmpty()) return emptyList()
        return db.select(MESSAGES.ID, MESSAGES.SEQUENCE, MESSAGES.SENDER_ID, MESSAGES.MESSAGE_VERSION).from(MESSAGES)
            .join(CHATS).on(CHATS.ID.eq(MESSAGES.CHAT_ID)).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .where(
                MESSAGES.CHAT_ID.eq(chatId.value),
                CHAT_MEMBERS.USER_ID.eq(userId.value),
                CHATS.DELETED_AT.isNull,
                MESSAGES.ID.`in`(ids.map { it.value }),
                MESSAGES.SEQUENCE.gt(CHATS.CLEARED_THROUGH_SEQUENCE),
            )
            .and(if (scope == DeletionScope.SELF) visibleMessage(chatId, userId, MESSAGES.SEQUENCE) else DSL.trueCondition())
            .fetch {
                DeletionMessage(
                    id = MessageId(it.get(MESSAGES.ID)!!),
                    sequence = it.get(MESSAGES.SEQUENCE)!!,
                    senderId = UserId(it.get(MESSAGES.SENDER_ID)!!),
                    messageVersion = it.get(MESSAGES.MESSAGE_VERSION)!!,
                )
            }
    }

    override fun lockChat(chatId: ChatId, userId: UserId): DeletionChat? =
        db.select(CHATS.asterisk(), CHAT_MEMBERS.VISIBILITY_SEQ)
            .from(CHATS).join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .where(CHATS.ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value))
            .forNoKeyUpdate().of(CHATS).fetchOne {
                val chat = it.into(CHATS)
                DeletionChat(
                    kind = ChatKind.valueOf(chat.kind!!.name),
                    ownerId = chat.ownerId?.let(::UserId),
                    lastSequence = chat.nextSequence!! - 1,
                    visibilitySeq = it.get(CHAT_MEMBERS.VISIBILITY_SEQ)!!,
                    purgedRows = chat.purgedRows!!,
                    deleted = chat.deletedAt != null,
                )
            }

    override fun hideMessages(chatId: ChatId, userId: UserId, messages: List<DeletionMessage>) {
        lockMembership(chatId, userId)
        for (message in messages.sortedBy { it.sequence }) hideMessage(chatId, userId, message.sequence)
    }

    private fun lockMembership(chatId: ChatId, userId: UserId) {
        checkNotNull(
            db.select(CHAT_MEMBERS.USER_ID).from(CHAT_MEMBERS)
                .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value)).forUpdate().fetchOne(),
        )
    }

    private fun hideMessage(chatId: ChatId, userId: UserId, sequence: Long) {
        val touching = touchingHiddenRanges(chatId = chatId, userId = userId, after = sequence - 1, through = sequence)
        if (touching.isNotEmpty()) deleteHiddenRanges(chatId, userId, touching)
        insertHiddenRange(
            chatId = chatId,
            userId = userId,
            after = (touching.map { it.afterSequence!! } + (sequence - 1)).min(),
            through = (touching.map { it.throughSequence!! } + sequence).max(),
        )
    }

    private fun touchingHiddenRanges(chatId: ChatId, userId: UserId, after: Long, through: Long): List<HiddenMessageRangesRecord> {
        val base = HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value).and(HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value))
        val left = db.selectFrom(HIDDEN_MESSAGE_RANGES).where(base, HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.le(after))
            .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1).fetchOne()?.takeIf { it.throughSequence!! >= after }
        val right = db.selectFrom(HIDDEN_MESSAGE_RANGES).where(base, HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.eq(through)).fetchOne()
        return listOfNotNull(left, right).distinctBy { it.afterSequence }
    }

    private fun deleteHiddenRanges(chatId: ChatId, userId: UserId, ranges: List<HiddenMessageRangesRecord>) {
        db.deleteFrom(HIDDEN_MESSAGE_RANGES).where(
            HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
            HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
            HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.`in`(
                ranges.map {
                    it.afterSequence
                },
            ),
        ).execute()
    }

    private fun insertHiddenRange(chatId: ChatId, userId: UserId, after: Long, through: Long) {
        db.insertInto(
            HIDDEN_MESSAGE_RANGES,
        ).set(HIDDEN_MESSAGE_RANGES.CHAT_ID, chatId.value).set(HIDDEN_MESSAGE_RANGES.USER_ID, userId.value)
            .set(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE, after).set(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE, through).execute()
    }

    override fun clearPersonal(chatId: ChatId, userId: UserId, through: Long, hide: Boolean) {
        db.update(
            CHAT_MEMBERS,
        ).set(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE, DSL.greatest(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE, DSL.`val`(through)))
            .set(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE, if (hide) through else null)
            .set(CHAT_MEMBERS.PINNED_RANK, if (hide) DSL.inline(null, CHAT_MEMBERS.PINNED_RANK) else CHAT_MEMBERS.PINNED_RANK)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value)).execute()
        db.insertInto(
            VISIBILITY_CLEANUP_JOBS,
        ).set(VISIBILITY_CLEANUP_JOBS.CHAT_ID, chatId.value).set(VISIBILITY_CLEANUP_JOBS.USER_ID, userId.value)
            .set(
                VISIBILITY_CLEANUP_JOBS.THROUGH_SEQUENCE,
                through,
            ).onConflict(VISIBILITY_CLEANUP_JOBS.CHAT_ID, VISIBILITY_CLEANUP_JOBS.USER_ID)
            .doUpdate().set(
                VISIBILITY_CLEANUP_JOBS.THROUGH_SEQUENCE,
                DSL.greatest(VISIBILITY_CLEANUP_JOBS.THROUGH_SEQUENCE, DSL.`val`(through)),
            ).execute()
    }

    override fun removeMessages(chatId: ChatId, messages: List<DeletionMessage>, seq: Long) {
        recordSharedPinRemoval(chatId, MESSAGE_PINS.SEQUENCE.`in`(messages.map { it.sequence }), seq)
        for (message in messages) {
            db.insertInto(MESSAGE_CHANGES).set(MESSAGE_CHANGES.CHAT_ID, chatId.value).set(MESSAGE_CHANGES.SEQ, seq)
                .set(
                    MESSAGE_CHANGES.KIND,
                    MessageChangeKind.REMOVED.name,
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
    }

    private fun recordSharedPinRemoval(chatId: ChatId, removed: Condition, seq: Long) {
        db.update(CHATS).set(CHATS.PINS_SEQ, seq)
            .where(CHATS.ID.eq(chatId.value))
            .andExists(
                DSL.selectOne().from(MESSAGE_PINS).where(MESSAGE_PINS.CHAT_ID.eq(chatId.value), MESSAGE_PINS.VIEWER_ID.isNull, removed),
            )
            .execute()
    }

    override fun repairClosedPurge(chatId: ChatId, through: Long) {
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
            .raisePurgeThrough(through).execute()
        Unit
    }

    override fun clearGlobal(chatId: ChatId, userId: UserId, through: Long, close: Boolean, seq: Long) {
        val now = OffsetDateTime.now(clock)
        recordSharedPinRemoval(chatId, MESSAGE_PINS.SEQUENCE.le(through), seq)
        db.update(CHATS).set(CHATS.CLEARED_THROUGH_SEQUENCE, DSL.greatest(CHATS.CLEARED_THROUGH_SEQUENCE, DSL.`val`(through)))
            .where(CHATS.ID.eq(chatId.value)).execute()
        if (close) {
            db.update(
                CHATS,
            ).set(
                CHATS.DELETED_AT,
                now,
            ).set(CHATS.DELETED_BY, userId.value).setNull(CHATS.DIRECT_PAIR_KEY).where(CHATS.ID.eq(chatId.value)).execute()
        }
        db.insertInto(MESSAGE_CHANGES).set(MESSAGE_CHANGES.CHAT_ID, chatId.value).set(MESSAGE_CHANGES.SEQ, seq)
            .set(
                MESSAGE_CHANGES.KIND,
                MessageChangeKind.CLEARED.name,
            ).set(MESSAGE_CHANGES.CLEARED_THROUGH_SEQUENCE, through).set(MESSAGE_CHANGES.CHANGED_AT, now).execute()
        db.insertInto(HISTORY_PURGE_JOBS).set(HISTORY_PURGE_JOBS.CHAT_ID, chatId.value).set(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, through)
            .raisePurgeThrough(through).execute()
    }

    private fun InsertOnDuplicateStep<HistoryPurgeJobsRecord>.raisePurgeThrough(through: Long) =
        onConflict(HISTORY_PURGE_JOBS.CHAT_ID).doUpdate()
            .set(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, DSL.greatest(HISTORY_PURGE_JOBS.THROUGH_SEQUENCE, DSL.`val`(through)))

    override fun saveOperation(
        chatId: ChatId,
        userId: UserId,
        requestId: RequestId,
        scope: DeletionScope,
        target: DeletionTarget,
        fingerprint: String,
        chat: DeletionChat,
        sequences: DeletionSequences,
        rows: Int,
    ) {
        db.insertInto(
            DELETION_OPERATIONS,
        ).set(DELETION_OPERATIONS.ACTOR_ID, userId.value).set(DELETION_OPERATIONS.REQUEST_ID, requestId.value)
            .set(
                DELETION_OPERATIONS.CHAT_ID,
                chatId.value,
            ).set(DELETION_OPERATIONS.FINGERPRINT, fingerprint).set(DELETION_OPERATIONS.SCOPE, scope.name)
            .set(DELETION_OPERATIONS.TARGET, target.name).set(
                DELETION_OPERATIONS.THROUGH_SEQUENCE,
                if (target == DeletionTarget.MESSAGES) {
                    0L
                } else {
                    chat.lastSequence
                },
            )
            .set(DELETION_OPERATIONS.SEQ, sequences.seq).set(DELETION_OPERATIONS.VISIBILITY_SEQ, sequences.visibilitySeq)
            .set(DELETION_OPERATIONS.DELETED_ROWS, rows.toLong()).set(DELETION_OPERATIONS.PURGE_ROWS_BEFORE, chat.purgedRows).execute()
        Unit
    }
}

private fun DeletionOperationsRecord.toModel(purgedThroughSequence: Long, purgedRows: Long): StoredDeletion {
    val scope = DeletionScope.valueOf(scope!!)
    val target = DeletionTarget.valueOf(target!!)
    val prefix = scope == DeletionScope.EVERYONE && target != DeletionTarget.MESSAGES
    val complete = !prefix || purgedThroughSequence >= throughSequence!!
    return StoredDeletion(
        requestId = RequestId(requestId!!),
        chatId = ChatId(chatId!!),
        fingerprint = fingerprint!!,
        scope = scope,
        target = target,
        clearedThroughSequence = throughSequence!!,
        seq = seq!!,
        visibilitySeq = visibilitySeq!!,
        state = if (complete) DeletionState.COMPLETED else DeletionState.ACCEPTED,
        deletedRows = if (prefix) maxOf(0L, purgedRows - purgeRowsBefore!!) else deletedRows!!,
    )
}
