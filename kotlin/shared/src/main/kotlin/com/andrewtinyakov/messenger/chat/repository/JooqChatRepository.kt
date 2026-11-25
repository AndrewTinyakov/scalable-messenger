package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.MemberChange
import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.ChatsRecord
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.message.model.SendBatch
import org.jooq.DSLContext
import org.jooq.JSONB
import org.jooq.Query
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind as DbChatKind

private const val INSERT_CHUNK_SIZE = 500
private const val MAX_CREATION_EVENT_BYTES = 1_048_576L

@Repository
class JooqChatRepository(
    private val db: DSLContext,
) : ChatRepository {
    override fun existingMemberIds(
        chatId: ChatId,
        userIds: List<UserId>,
    ): Set<UserId> =
        db.select(CHAT_MEMBERS.USER_ID)
            .from(CHAT_MEMBERS)
            .join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(
                CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
                CHAT_MEMBERS.USER_ID.`in`(userIds.map(UserId::value)),
                CHATS.DELETED_AT.isNull,
            )
            .fetch(CHAT_MEMBERS.USER_ID)
            .filterNotNull()
            .map(::UserId)
            .toSet()

    override fun findByDirectKey(key: String): ChatId? =
        db.select(CHATS.ID)
            .from(CHATS)
            .where(CHATS.DIRECT_PAIR_KEY.eq(key), CHATS.DELETED_AT.isNull)
            .fetchOne(CHATS.ID)
            ?.let(::ChatId)

    override fun lockDirectPair(key: String) =
        Routines.acquireTransactionLock(db.configuration(), "direct:$key")

    override fun findByIdForUpdate(chatId: ChatId): Chat? =
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .forNoKeyUpdate()
            .fetchOne()
            ?.toModel()

    override fun insertDirectWithMembersAndEvents(
        id: ChatId,
        key: String,
        members: List<UserId>,
        events: List<OutboxMessage>,
    ) {
        require(members.size == 2 && members.distinct().size == 2)
        val chat = db.insertInto(CHATS)
            .set(
                CHATS.ID,
                id.value,
            )
            .set(
                CHATS.KIND,
                DbChatKind.DIRECT,
            )
            .set(
                CHATS.DIRECT_PAIR_KEY,
                key,
            )
            .set(
                CHATS.MEMBER_COUNT,
                members.size,
            )
        insertChatWithMembersAndEvents(
            chat = chat,
            chatId = id,
            members = members,
            events = events,
        )
    }

    override fun insertGroupWithMembersAndEvents(
        id: ChatId,
        name: String,
        ownerId: UserId,
        members: List<UserId>,
        events: List<OutboxMessage>,
    ) {
        require(members.size in 2..Chat.MAX_INITIAL_GROUP_MEMBERS && members.distinct().size == members.size && ownerId in members)
        val chat = db.insertInto(CHATS)
            .set(
                CHATS.ID,
                id.value,
            )
            .set(
                CHATS.KIND,
                DbChatKind.GROUP,
            )
            .set(
                CHATS.NAME,
                name,
            )
            .set(
                CHATS.OWNER_ID,
                ownerId.value,
            )
            .set(
                CHATS.MEMBER_COUNT,
                members.size,
            )
        insertChatWithMembersAndEvents(
            chat = chat,
            chatId = id,
            members = members,
            events = events,
        )
    }

    private fun insertChatWithMembersAndEvents(
        chat: Query,
        chatId: ChatId,
        members: List<UserId>,
        events: List<OutboxMessage>,
    ) {
        require(events.size == members.size)
        require(events.sumOf { it.payload.toByteArray(Charsets.UTF_8).size.toLong() } <= MAX_CREATION_EVENT_BYTES)
        val statements = mutableListOf(chat)
        val expectedCounts = mutableListOf(1)
        members.chunked(INSERT_CHUNK_SIZE)
            .forEach { chunk ->
                val insert = db.insertInto(
                    CHAT_MEMBERS,
                    CHAT_MEMBERS.CHAT_ID,
                    CHAT_MEMBERS.USER_ID,
                )
                chunk.forEach {
                    insert.values(
                        chatId.value,
                        it.value,
                    )
                }
                statements.add(insert)
                expectedCounts.add(chunk.size)
            }
        events.chunked(INSERT_CHUNK_SIZE)
            .forEach { chunk ->
                val insert = db.insertInto(
                    MESSENGER_OUTBOX_EVENTS,
                    MESSENGER_OUTBOX_EVENTS.ID,
                    MESSENGER_OUTBOX_EVENTS.ROOM,
                    MESSENGER_OUTBOX_EVENTS.PAYLOAD,
                )
                chunk.forEach {
                    insert.values(
                        it.id.value,
                        it.room,
                        JSONB.valueOf(it.payload),
                    )
                }
                statements.add(insert)
                expectedCounts.add(chunk.size)
            }
        val actualCounts = db.batch(statements)
            .execute()
        check(actualCounts.toList() == expectedCounts) { "Chat creation affected unexpected row counts: ${actualCounts.toList()}" }
    }

    override fun isMember(
        chatId: ChatId,
        userId: UserId,
    ): Boolean =
        db.fetchExists(
            db.selectOne()
                .from(CHAT_MEMBERS)
                .join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
                .where(
                    CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
                    CHAT_MEMBERS.USER_ID.eq(userId.value),
                    CHATS.DELETED_AT.isNull,
                ),
        )

    override fun allocateSequencesForMembers(chatId: ChatId, userIds: List<UserId>, recordActivity: Boolean): Long? {
        require(userIds.size in 1..SendBatch.MAX_SIZE) { "Sequence allocation must contain 1 to ${SendBatch.MAX_SIZE} senders" }
        val distinctUsers = userIds.distinct()
        val activityNow = DSL.field("clock_timestamp()", OffsetDateTime::class.java)
        return db.update(CHATS)
            .set(
                CHATS.NEXT_SEQUENCE,
                CHATS.NEXT_SEQUENCE.plus(userIds.size.toLong()),
            )
            .set(
                CHATS.LAST_ACTIVITY_AT,
                if (recordActivity) {
                    DSL.greatest(
                        DSL.coalesce(CHATS.LAST_ACTIVITY_AT, activityNow),
                        activityNow,
                    )
                } else {
                    CHATS.LAST_ACTIVITY_AT
                },
            )
            .set(
                CHATS.LAST_MESSAGE_SEQUENCE,
                if (recordActivity) CHATS.NEXT_SEQUENCE.plus(userIds.size.toLong() - 1) else CHATS.LAST_MESSAGE_SEQUENCE,
            )
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .and(
                DSL.field(
                    db.select(DSL.countDistinct(CHAT_MEMBERS.USER_ID))
                        .from(CHAT_MEMBERS)
                        .where(
                            CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
                            CHAT_MEMBERS.USER_ID.`in`(distinctUsers.map(UserId::value)),
                        ),
                ).eq(distinctUsers.size),
            )
            .returning(CHATS.NEXT_SEQUENCE)
            .fetchOne()?.nextSequence?.minus(userIds.size.toLong())
    }

    override fun allocateMemberSequence(chatId: ChatId, userId: UserId, change: MemberChange): Long? =
        db.update(CHAT_MEMBERS)
            .set(CHAT_MEMBERS.MEMBER_SEQ, CHAT_MEMBERS.MEMBER_SEQ.plus(1L))
            .set(
                CHAT_MEMBERS.VISIBILITY_SEQ,
                if (change == MemberChange.VISIBILITY) CHAT_MEMBERS.MEMBER_SEQ.plus(1L) else CHAT_MEMBERS.VISIBILITY_SEQ,
            )
            .set(CHAT_MEMBERS.PINS_SEQ, if (change == MemberChange.PINS) CHAT_MEMBERS.MEMBER_SEQ.plus(1L) else CHAT_MEMBERS.PINS_SEQ)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value))
            .returning(CHAT_MEMBERS.MEMBER_SEQ)
            .fetchOne()?.memberSeq

    override fun findMemberIds(chatId: ChatId): List<UserId> =
        db.select(CHAT_MEMBERS.USER_ID)
            .from(CHAT_MEMBERS)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value))
            .fetch(CHAT_MEMBERS.USER_ID)
            .filterNotNull()
            .map(::UserId)
}

fun ChatsRecord.toModel(): Chat =
    Chat(
        id = ChatId(id!!),
        kind = ChatKind.valueOf(kind!!.name),
        name = name,
        lastSequence = nextSequence!! - 1,
        ownerId = ownerId?.let(::UserId),
        memberCount = memberCount!!,
        activityAt = lastActivityAt,
    )
