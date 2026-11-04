package com.andrewtinyakov.messenger.chat.repository

import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.chat.model.ChatLastMessage
import com.andrewtinyakov.messenger.infrastructure.database.generated.Routines
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.records.ChatsRecord
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.DSLContext
import org.jooq.JSONB
import org.jooq.Query
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind as DbChatKind

@Repository
class JooqChatRepository(
    private val db: DSLContext,
) : ChatRepository {
    override fun findByMember(
        userId: UserId,
        beforeJoinedAt: OffsetDateTime?,
        beforeChatId: ChatId?,
        limit: Int,
    ): List<MemberChat> = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_BY_MEMBER) {
        val lastMessage = lastMessage(userId)
        db.select(
            lastMessage,
            CHATS.ID,
            CHATS.KIND,
            CHATS.NAME,
            CHATS.NEXT_SEQUENCE,
            CHAT_MEMBERS.JOINED_AT,
            CHATS.MEMBER_COUNT,
            CHATS.OWNER_ID,
        )
            .from(CHAT_MEMBERS)
            .join(CHATS)
            .on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .and(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE.isNull.or(CHATS.NEXT_SEQUENCE.minus(1L).gt(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE)))
            .and(
                if (beforeJoinedAt != null && beforeChatId != null) {
                    CHAT_MEMBERS.JOINED_AT.lt(beforeJoinedAt)
                        .or(
                            CHAT_MEMBERS.JOINED_AT.eq(beforeJoinedAt)
                                .and(CHAT_MEMBERS.CHAT_ID.lt(beforeChatId.value)),
                        )
                } else {
                    DSL.trueCondition()
                },
            )
            .orderBy(
                CHAT_MEMBERS.JOINED_AT.desc(),
                CHAT_MEMBERS.CHAT_ID.desc(),
            )
            .limit(limit)
            .fetch { row ->
                MemberChat(
                    chat = Chat(
                        id = ChatId(row.get(CHATS.ID)!!),
                        kind = ChatKind.valueOf(row.get(CHATS.KIND)!!.name),
                        name = row.get(CHATS.NAME),
                        lastSequence = row.get(CHATS.NEXT_SEQUENCE)!! - 1,
                        ownerId = row.get(CHATS.OWNER_ID)
                            ?.let(::UserId),
                        memberCount = row.get(CHATS.MEMBER_COUNT)!!,
                        lastMessage = row.get(lastMessage),
                    ),
                    joinedAt = row.get(CHAT_MEMBERS.JOINED_AT)!!,
                )
            }
    }

    private fun lastMessage(userId: UserId) = DSL.multiset(
        DSL.select(
            MESSAGES.ID,
            MESSAGES.SEQUENCE,
            MESSAGES.SENDER_ID,
            USERS.USERNAME,
            MESSAGES.CREATED_AT,
            DSL.left(MESSAGES.BODY, 160),
        ).from(MESSAGES)
            .join(USERS).on(USERS.ID.eq(MESSAGES.SENDER_ID))
            .join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(MESSAGES.CHAT_ID), CHAT_MEMBERS.USER_ID.eq(userId.value))
            .where(
                MESSAGES.CHAT_ID.eq(CHATS.ID),
                MESSAGES.DELETED_AT.isNull,
                MESSAGES.SEQUENCE.gt(CHATS.CLEARED_THROUGH_SEQUENCE),
                MESSAGES.SEQUENCE.gt(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE),
                CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE.isNull.or(CHATS.NEXT_SEQUENCE.minus(1L).gt(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE)),
                MESSAGES.SEQUENCE.gt(
                    DSL.coalesce(
                        DSL.select(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE).from(HIDDEN_MESSAGE_RANGES)
                            .where(
                                HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(CHATS.ID),
                                HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.lt(MESSAGES.SEQUENCE),
                            ).orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1).asField<Long>(),
                        DSL.inline(0L),
                    ),
                ),
            ).orderBy(MESSAGES.SEQUENCE.desc()).limit(1),
    ).convertFrom { rows ->
        rows.firstOrNull()?.let {
            ChatLastMessage(it.value1()!!, it.value2()!!, it.value3()!!, it.value4()!!, it.value5()!!, it.value6()!!, false)
        }
    }

    override fun findMembersByChatIds(chatIds: List<ChatId>): Map<ChatId, List<UserSummary>> = DatabaseObservation.query(
        DatabaseOperation.CHAT_FIND_MEMBERS_BY_CHAT_IDS,
    ) {
        if (chatIds.isEmpty()) return emptyMap()
        val rank = DSL.rowNumber()
            .over()
            .partitionBy(CHAT_MEMBERS.CHAT_ID)
            .orderBy(USERS.USERNAME)
            .`as`("rank")
        val ranked = db.select(
            CHAT_MEMBERS.CHAT_ID,
            USERS.ID,
            USERS.USERNAME,
            rank,
        )
            .from(CHAT_MEMBERS)
            .join(USERS)
            .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
            .where(CHAT_MEMBERS.CHAT_ID.`in`(chatIds.map(ChatId::value)))
            .asTable("ranked")
        val chatId = ranked.field(CHAT_MEMBERS.CHAT_ID)!!
        val userId = ranked.field(USERS.ID)!!
        val username = ranked.field(USERS.USERNAME)!!
        return db.select(
            chatId,
            userId,
            username,
        )
            .from(ranked)
            .where(
                ranked.field(rank)!!
                    .le(50),
            )
            .orderBy(
                chatId,
                username,
            )
            .fetch()
            .groupBy(
                keySelector = { ChatId(it.get(chatId)!!) },
                valueTransform = {
                    UserSummary(
                        id = UserId(it.get(userId)!!),
                        username = it.get(username)!!,
                    )
                },
            )
    }

    override fun existingMemberIds(
        chatId: ChatId,
        userIds: List<UserId>,
    ): Set<UserId> = DatabaseObservation.query(DatabaseOperation.CHAT_EXISTING_MEMBER_IDS) {
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
    }

    override fun lockUsers(userIds: List<UserId>): Set<UserId> = DatabaseObservation.query(DatabaseOperation.CHAT_LOCK_USERS) {
        db.select(USERS.ID)
            .from(USERS)
            .where(USERS.ID.`in`(userIds.map(UserId::value)))
            .orderBy(USERS.ID)
            .forNoKeyUpdate()
            .fetch(USERS.ID)
            .map { UserId(requireNotNull(it)) }
            .toSet()
    }

    override fun groupCountsByUser(userIds: List<UserId>): Map<UserId, Int> = DatabaseObservation.query(
        DatabaseOperation.CHAT_GROUP_COUNTS_BY_USER,
    ) {
        db.select(
            CHAT_MEMBERS.USER_ID,
            DSL.count(),
        )
            .from(CHAT_MEMBERS)
            .join(CHATS)
            .on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(
                CHAT_MEMBERS.USER_ID.`in`(userIds.map(UserId::value)),
                CHATS.KIND.eq(DbChatKind.GROUP),
                CHATS.DELETED_AT.isNull,
            )
            .groupBy(CHAT_MEMBERS.USER_ID)
            .fetchMap(
                CHAT_MEMBERS.USER_ID,
                DSL.count(),
            )
            .mapKeys { (userId, _) -> UserId(userId!!) }
    }

    override fun findByDirectKey(key: String): ChatId? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_BY_DIRECT_KEY) {
        db.select(CHATS.ID)
            .from(CHATS)
            .where(CHATS.DIRECT_PAIR_KEY.eq(key), CHATS.DELETED_AT.isNull)
            .fetchOne(CHATS.ID)
            ?.let(::ChatId)
    }

    override fun lockDirectPair(key: String) = DatabaseObservation.query(DatabaseOperation.CHAT_LOCK_DIRECT_PAIR) {
        Routines.acquireTransactionLock(db.configuration(), "direct:$key")
    }

    override fun findByIdForUpdate(chatId: ChatId): Chat? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_BY_ID_FOR_UPDATE) {
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .forNoKeyUpdate()
            .fetchOne()
            ?.toModel()
    }

    override fun insertDirectWithMembersAndEvents(
        id: ChatId,
        key: String,
        members: List<UserId>,
        events: List<OutboxMessage>,
    ) = DatabaseObservation.query(DatabaseOperation.CHAT_INSERT_DIRECT_WITH_MEMBERS_AND_EVENTS) {
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
    ) = DatabaseObservation.query(DatabaseOperation.CHAT_INSERT_GROUP_WITH_MEMBERS_AND_EVENTS) {
        require(members.size in 2..1000 && members.distinct().size == members.size && ownerId in members)
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
        require(events.sumOf { it.payload.toByteArray(Charsets.UTF_8).size.toLong() } <= 1_048_576)
        val statements = mutableListOf(chat)
        val expectedCounts = mutableListOf(1)
        members.chunked(500)
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
        events.chunked(500)
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

    override fun insertMembersAndIncrementCount(
        chatId: ChatId,
        userIds: List<UserId>,
    ) = DatabaseObservation.query(DatabaseOperation.CHAT_INSERT_MEMBERS_AND_INCREMENT_COUNT) {
        if (userIds.isEmpty()) return@query
        userIds.chunked(500)
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
                check(insert.execute() == chunk.size)
            }
        val updated = db.update(CHATS)
            .set(
                CHATS.MEMBER_COUNT,
                CHATS.MEMBER_COUNT.plus(userIds.size),
            )
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .execute()
        check(updated == 1)
    }

    override fun findById(chatId: ChatId): Chat? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_BY_ID) {
        db.selectFrom(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .fetchOne()
            ?.toModel()
    }

    override fun findMemberDetails(
        chatId: ChatId,
        userId: UserId,
    ): MemberChatDetails? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_MEMBER_DETAILS) {
        val members = DSL.multiset(
            DSL.select(
                USERS.ID,
                USERS.USERNAME,
            )
                .from(CHAT_MEMBERS)
                .join(USERS)
                .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
                .where(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
                .orderBy(CHAT_MEMBERS.USER_ID)
                .limit(50),
        )
            .convertFrom { rows ->
                rows.map {
                    UserSummary(
                        id = UserId(it.value1()!!),
                        username = it.value2()!!,
                    )
                }
            }
        val lastMessage = lastMessage(userId)
        return db.select(
            CHATS.asterisk(),
            members,
            lastMessage,
        )
            .from(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull)
            .and(
                DSL.exists(
                    DSL.selectOne()
                        .from(CHAT_MEMBERS)
                        .where(
                            CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID),
                            CHAT_MEMBERS.USER_ID.eq(userId.value),
                        ),
                ),
            )
            .fetchOne { row ->
                MemberChatDetails(
                    chat = row.into(CHATS)
                        .toModel().copy(lastMessage = row.get(lastMessage)),
                    members = row.get(members),
                )
            }
    }

    override fun findGroupMemberPage(
        chatId: ChatId,
        viewerId: UserId,
        afterUserId: UserId?,
        limit: Int,
    ): List<UserSummary>? = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_GROUP_MEMBER_PAGE) {
        val members = DSL.multiset(
            DSL.select(USERS.ID, USERS.USERNAME)
                .from(CHAT_MEMBERS)
                .join(USERS)
                .on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
                .where(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
                .and(afterUserId?.let { CHAT_MEMBERS.USER_ID.gt(it.value) } ?: DSL.trueCondition())
                .orderBy(CHAT_MEMBERS.USER_ID)
                .limit(limit),
        ).convertFrom { rows ->
            rows.map { UserSummary(id = UserId(it.value1()!!), username = it.value2()!!) }
        }
        return db.select(members)
            .from(CHATS)
            .where(CHATS.ID.eq(chatId.value), CHATS.KIND.eq(DbChatKind.GROUP), CHATS.DELETED_AT.isNull)
            .and(
                DSL.exists(
                    DSL.selectOne()
                        .from(CHAT_MEMBERS)
                        .where(
                            CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID),
                            CHAT_MEMBERS.USER_ID.eq(viewerId.value),
                        ),
                ),
            )
            .fetchOne { it.get(members) }
    }

    override fun findMembers(chatId: ChatId): List<UserSummary> = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_MEMBERS) {
        val preview = db.select(CHAT_MEMBERS.USER_ID)
            .from(CHAT_MEMBERS)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value))
            .orderBy(CHAT_MEMBERS.USER_ID)
            .limit(50)
            .asTable("preview")
        val previewUserId = preview.field(CHAT_MEMBERS.USER_ID)!!
        return db.select(
            USERS.ID,
            USERS.USERNAME,
        )
            .from(preview)
            .join(USERS)
            .on(USERS.ID.eq(previewUserId))
            .orderBy(previewUserId)
            .fetch {
                UserSummary(
                    id = UserId(it.get(USERS.ID)!!),
                    username = it.get(USERS.USERNAME)!!,
                )
            }
    }

    override fun isMember(
        chatId: ChatId,
        userId: UserId,
    ): Boolean = DatabaseObservation.query(DatabaseOperation.CHAT_IS_MEMBER) {
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
    }

    override fun isGroupMember(
        chatId: ChatId,
        userId: UserId,
    ): Boolean = DatabaseObservation.query(DatabaseOperation.CHAT_IS_GROUP_MEMBER) {
        db.fetchExists(
            db.selectOne()
                .from(CHAT_MEMBERS)
                .join(CHATS)
                .on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
                .where(
                    CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
                    CHAT_MEMBERS.USER_ID.eq(userId.value),
                    CHATS.KIND.eq(DbChatKind.GROUP),
                    CHATS.DELETED_AT.isNull,
                ),
        )
    }

    override fun groupMemberships(
        chatIds: List<ChatId>,
        userId: UserId,
    ): Set<ChatId> = DatabaseObservation.query(DatabaseOperation.CHAT_GROUP_MEMBERSHIPS) {
        if (chatIds.isEmpty()) return emptySet()
        return db.select(CHAT_MEMBERS.CHAT_ID)
            .from(CHAT_MEMBERS)
            .join(CHATS)
            .on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
            .where(
                CHAT_MEMBERS.USER_ID.eq(userId.value),
                CHAT_MEMBERS.CHAT_ID.`in`(chatIds.map(ChatId::value)),
                CHATS.KIND.eq(DbChatKind.GROUP),
                CHATS.DELETED_AT.isNull,
            )
            .fetch(CHAT_MEMBERS.CHAT_ID)
            .filterNotNull()
            .map(::ChatId)
            .toSet()
    }

    override fun allocateSequenceForMember(
        chatId: ChatId,
        userId: UserId,
    ): Long? = DatabaseObservation.query(DatabaseOperation.CHAT_ALLOCATE_SEQUENCE_FOR_MEMBER) {
        allocateSequencesForMembers(chatId, listOf(userId))
    }

    override fun allocateSequencesForMembers(chatId: ChatId, userIds: List<UserId>): Long? = DatabaseObservation.query(
        DatabaseOperation.CHAT_ALLOCATE_SEQUENCES_FOR_MEMBERS,
    ) {
        require(userIds.size in 1..16) { "Sequence allocation must contain one to sixteen senders" }
        val distinctUsers = userIds.distinct()
        return db.update(CHATS)
            .set(
                CHATS.NEXT_SEQUENCE,
                CHATS.NEXT_SEQUENCE.plus(userIds.size.toLong()),
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

    override fun findMemberIds(chatId: ChatId): List<UserId> = DatabaseObservation.query(DatabaseOperation.CHAT_FIND_MEMBER_IDS) {
        db.select(CHAT_MEMBERS.USER_ID)
            .from(CHAT_MEMBERS)
            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value))
            .fetch(CHAT_MEMBERS.USER_ID)
            .filterNotNull()
            .map(::UserId)
    }

    override fun deleteMemberAndDecrementCount(
        chatId: ChatId,
        userId: UserId,
    ): Boolean = DatabaseObservation.query(DatabaseOperation.CHAT_DELETE_MEMBER_AND_DECREMENT_COUNT) {
        val removed = DSL.name("removed")
            .`as`(
                db.deleteFrom(CHAT_MEMBERS)
                    .where(
                        CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
                        CHAT_MEMBERS.USER_ID.eq(userId.value),
                    )
                    .returningResult(CHAT_MEMBERS.CHAT_ID),
            )
        val removedChatId = removed.field(CHAT_MEMBERS.CHAT_ID)!!
        val updated = db.with(removed)
            .update(CHATS)
            .set(
                CHATS.MEMBER_COUNT,
                CHATS.MEMBER_COUNT.minus(1),
            )
            .from(removed)
            .where(CHATS.ID.eq(removedChatId))
            .returning(CHATS.ID)
            .fetch()
        check(updated.size <= 1)
        return updated.isNotEmpty()
    }
}

private fun ChatsRecord.toModel(): Chat =
    Chat(
        id = ChatId(id!!),
        kind = ChatKind.valueOf(kind!!.name),
        name = name,
        lastSequence = nextSequence!! - 1,
        ownerId = ownerId?.let(::UserId),
        memberCount = memberCount!!,
    )
