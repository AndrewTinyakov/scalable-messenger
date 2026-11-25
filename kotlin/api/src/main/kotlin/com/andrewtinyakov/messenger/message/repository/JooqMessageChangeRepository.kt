package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_CHANGES
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.change.MessageChange
import com.andrewtinyakov.messenger.message.model.change.MessageChangeKind
import com.andrewtinyakov.messenger.message.model.change.MessageChangePage
import com.andrewtinyakov.messenger.message.model.change.MutationCursor
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqMessageChangeRepository(
    private val db: DSLContext,
) : MessageChangeRepository {
    override fun cursor(chatId: ChatId, userId: UserId): MutationCursor? =
        db.select(CHATS.NEXT_SEQUENCE, CHATS.MUTATION_FLOOR)
            .from(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .and(
                DSL.exists(
                    DSL.selectOne().from(CHAT_MEMBERS)
                        .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value)),
                ),
            )
            .fetchOne { MutationCursor(it.value1()!! - 1, it.value2()!!) }

    override fun page(chatId: ChatId, afterSeq: Long, throughSeq: Long, limit: Int): MessageChangePage {
        val rows = changes(chatId, afterSeq, throughSeq, limit + 1)
        if (rows.size <= limit) return MessageChangePage(rows, throughSeq)
        val overflow = rows[limit].seq
        val complete = rows.filter { it.seq < overflow }
        if (complete.isNotEmpty()) return MessageChangePage(complete, complete.last().seq)
        return MessageChangePage(changes(chatId, afterSeq, overflow, null), overflow)
    }

    private fun changes(chatId: ChatId, afterSeq: Long, throughSeq: Long, limit: Int?): List<MessageChange> =
        db.select(
            MESSAGE_CHANGES.SEQ,
            MESSAGE_CHANGES.MESSAGE_ID,
            MESSAGE_CHANGES.KIND,
            MESSAGE_CHANGES.SEQUENCE,
            MESSAGE_CHANGES.CLEARED_THROUGH_SEQUENCE,
        ).from(MESSAGE_CHANGES)
            .where(changesBetween(chatId, afterSeq, throughSeq))
            .orderBy(MESSAGE_CHANGES.SEQ, MESSAGE_CHANGES.SEQUENCE)
            .limit(limit ?: Int.MAX_VALUE)
            .fetch {
                MessageChange(
                    seq = it.value1()!!,
                    messageId = it.value2()?.let(::MessageId),
                    kind = MessageChangeKind.valueOf(it.value3()!!),
                    sequence = it.value4(),
                    clearedThroughSequence = it.value5(),
                )
            }

    private fun changesBetween(chatId: ChatId, afterSeq: Long, throughSeq: Long) = MESSAGE_CHANGES.CHAT_ID.eq(chatId.value)
        .and(MESSAGE_CHANGES.SEQ.gt(afterSeq))
        .and(MESSAGE_CHANGES.SEQ.le(throughSeq))

    override fun edit(chatId: ChatId, messageId: MessageId, body: String, now: OffsetDateTime, seq: Long) {
        check(
            db.update(MESSAGES).set(MESSAGES.BODY, body)
                .set(MESSAGES.MESSAGE_VERSION, MESSAGES.MESSAGE_VERSION.plus(1L))
                .set(MESSAGES.EDITED_AT, now)
                .where(MESSAGES.CHAT_ID.eq(chatId.value), MESSAGES.ID.eq(messageId.value)).execute() == 1,
        )
        check(
            db.insertInto(MESSAGE_CHANGES).set(MESSAGE_CHANGES.CHAT_ID, chatId.value)
                .set(MESSAGE_CHANGES.SEQ, seq).set(MESSAGE_CHANGES.MESSAGE_ID, messageId.value)
                .set(
                    MESSAGE_CHANGES.SEQUENCE,
                    DSL.field(db.select(MESSAGES.SEQUENCE).from(MESSAGES).where(MESSAGES.ID.eq(messageId.value))),
                )
                .set(MESSAGE_CHANGES.CHANGED_AT, now).execute() == 1,
        )
    }

    override fun prune(before: OffsetDateTime, limit: Int): Int {
        require(limit in 1..1000)
        val candidates = db.selectFrom(MESSAGE_CHANGES).where(MESSAGE_CHANGES.CHANGED_AT.lt(before))
            .orderBy(MESSAGE_CHANGES.CHANGED_AT, MESSAGE_CHANGES.CHAT_ID, MESSAGE_CHANGES.SEQ).limit(limit).fetch()
        if (candidates.isEmpty()) return 0
        val locked = db.select(CHATS.ID).from(CHATS)
            .where(CHATS.ID.`in`(candidates.map { it.chatId }.distinct())).orderBy(CHATS.ID)
            .forNoKeyUpdate().skipLocked().fetch(CHATS.ID).toSet()
        var removed = 0
        for ((chat, rows) in candidates.filter { it.chatId in locked }.groupBy { it.chatId }) {
            val floor = rows.maxOf { it.seq!! }
            check(
                db.update(CHATS).set(CHATS.MUTATION_FLOOR, DSL.greatest(CHATS.MUTATION_FLOOR, DSL.`val`(floor)))
                    .where(CHATS.ID.eq(chat)).execute() == 1,
            )
            removed += db.deleteFrom(MESSAGE_CHANGES)
                .where(MESSAGE_CHANGES.CHAT_ID.eq(chat), MESSAGE_CHANGES.SEQ.le(floor)).execute()
        }
        return removed
    }
}
