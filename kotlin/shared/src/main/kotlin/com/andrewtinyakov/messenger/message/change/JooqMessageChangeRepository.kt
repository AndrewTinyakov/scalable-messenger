package com.andrewtinyakov.messenger.message.change

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_CHANGES
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqMessageChangeRepository(
    private val db: DSLContext,
) : MessageChangeRepository {
    override fun cursor(chatId: ChatId, userId: UserId): MutationCursor? =
        DatabaseObservation.query(DatabaseOperation.MESSAGE_CHANGE_CURSOR) {
            db.select(CHATS.MUTATION_REVISION, CHATS.MUTATION_FLOOR)
                .from(CHATS)
                .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
                .and(
                    DSL.exists(
                        DSL.selectOne().from(CHAT_MEMBERS)
                            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value)),
                    ),
                )
                .fetchOne { MutationCursor(it.value1()!!, it.value2()!!) }
        }

    override fun changes(chatId: ChatId, afterRevision: Long, throughRevision: Long, limit: Int): List<MessageChange> =
        DatabaseObservation.query(DatabaseOperation.MESSAGE_CHANGE_PAGE) {
            db.select(MESSAGE_CHANGES.REVISION, MESSAGE_CHANGES.MESSAGE_ID).from(MESSAGE_CHANGES)
                .where(
                    MESSAGE_CHANGES.CHAT_ID.eq(chatId.value),
                    MESSAGE_CHANGES.REVISION.gt(afterRevision),
                    MESSAGE_CHANGES.REVISION.le(throughRevision),
                )
                .orderBy(MESSAGE_CHANGES.REVISION).limit(limit)
                .fetch { MessageChange(it.value1()!!, MessageId(it.value2()!!)) }
        }

    override fun mutate(chatId: ChatId, messageId: MessageId, body: String, deleted: Boolean, now: OffsetDateTime): Long =
        DatabaseObservation.query(DatabaseOperation.MESSAGE_MUTATE) {
            check(
                db.update(MESSAGES).set(MESSAGES.BODY, body)
                    .set(MESSAGES.MESSAGE_VERSION, MESSAGES.MESSAGE_VERSION.plus(1L))
                    .set(MESSAGES.EDITED_AT, if (deleted) MESSAGES.EDITED_AT else DSL.`val`(now))
                    .set(MESSAGES.DELETED_AT, if (deleted) now else null)
                    .where(MESSAGES.CHAT_ID.eq(chatId.value), MESSAGES.ID.eq(messageId.value)).execute() == 1,
            )
            val revision = db.update(CHATS).set(CHATS.MUTATION_REVISION, CHATS.MUTATION_REVISION.plus(1L))
                .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
                .returning(CHATS.MUTATION_REVISION).fetchOne()!!.mutationRevision!!
            check(
                db.insertInto(MESSAGE_CHANGES).set(MESSAGE_CHANGES.CHAT_ID, chatId.value)
                    .set(MESSAGE_CHANGES.REVISION, revision).set(MESSAGE_CHANGES.MESSAGE_ID, messageId.value)
                    .set(MESSAGE_CHANGES.CHANGED_AT, now).execute() == 1,
            )
            revision
        }

    override fun prune(before: OffsetDateTime, limit: Int): Int = DatabaseObservation.query(DatabaseOperation.MESSAGE_CHANGE_PRUNE) {
        require(limit in 1..1000)
        val candidates = db.selectFrom(MESSAGE_CHANGES).where(MESSAGE_CHANGES.CHANGED_AT.lt(before))
            .orderBy(MESSAGE_CHANGES.CHANGED_AT, MESSAGE_CHANGES.CHAT_ID, MESSAGE_CHANGES.REVISION).limit(limit).fetch()
        if (candidates.isEmpty()) return@query 0
        val locked = db.select(CHATS.ID).from(CHATS)
            .where(CHATS.ID.`in`(candidates.map { it.chatId }.distinct())).orderBy(CHATS.ID)
            .forNoKeyUpdate().skipLocked().fetch(CHATS.ID).toSet()
        var removed = 0
        for ((chat, rows) in candidates.filter { it.chatId in locked }.groupBy { it.chatId }) {
            val floor = rows.maxOf { it.revision!! }
            check(
                db.update(CHATS).set(CHATS.MUTATION_FLOOR, DSL.greatest(CHATS.MUTATION_FLOOR, DSL.`val`(floor)))
                    .where(CHATS.ID.eq(chat)).execute() == 1,
            )
            removed += db.deleteFrom(MESSAGE_CHANGES)
                .where(MESSAGE_CHANGES.CHAT_ID.eq(chat), MESSAGE_CHANGES.REVISION.`in`(rows.map { it.revision })).execute()
        }
        removed
    }
}
