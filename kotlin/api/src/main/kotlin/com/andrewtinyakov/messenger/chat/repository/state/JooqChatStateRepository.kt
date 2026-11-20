package com.andrewtinyakov.messenger.chat.repository.state

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.ChatState
import com.andrewtinyakov.messenger.chat.repository.directory.hidden
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_PROGRESS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.USERS
import com.andrewtinyakov.messenger.message.repository.mutationSeq
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository

@Repository
class JooqChatStateRepository(
    private val db: DSLContext,
) : ChatStateRepository {
    override fun find(chatId: ChatId, userId: UserId): ChatState? {
        val own = DSL.select(CHAT_READ_PROGRESS.THROUGH_SEQUENCE).from(CHAT_READ_PROGRESS)
            .where(CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value), CHAT_READ_PROGRESS.USER_ID.eq(userId.value))
        val other = DSL.select(CHAT_READ_PROGRESS.THROUGH_SEQUENCE).from(CHAT_READ_PROGRESS)
            .where(
                CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value),
                CHAT_READ_PROGRESS.USER_ID.ne(userId.value),
                CHAT_READ_PROGRESS.ACTIVE_MEMBERSHIP.isTrue,
            )
            .orderBy(CHAT_READ_PROGRESS.THROUGH_SEQUENCE.desc()).limit(1)
        return db.select(
            CHATS.NEXT_SEQUENCE,
            CHATS.PINS_SEQ,
            CHATS.MUTATION_FLOOR,
            mutationSeq(chatId),
            CHAT_MEMBERS.MEMBER_SEQ,
            CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE,
            CHATS.CLEARED_THROUGH_SEQUENCE,
            DSL.field(hidden(CHAT_MEMBERS)),
            DSL.coalesce(own.asField<Long>(), DSL.inline(0L)),
            DSL.coalesce(other.asField<Long>(), DSL.inline(0L)),
            USERS.EVENT_SEQ,
        ).from(CHATS)
            .join(CHAT_MEMBERS).on(CHAT_MEMBERS.CHAT_ID.eq(CHATS.ID))
            .join(USERS).on(USERS.ID.eq(CHAT_MEMBERS.USER_ID))
            .where(CHATS.ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value), CHATS.DELETED_AT.isNull)
            .fetchOne {
                ChatState(
                    lastSeq = it.value1()!! - 1,
                    pinsSeq = it.value2()!!,
                    mutationFloor = it.value3()!!,
                    mutationSeq = it.value4()!!,
                    memberSeq = it.value5()!!,
                    clearedThroughSequence = it.value6()!!,
                    globalClearedThroughSequence = it.value7()!!,
                    hidden = it.value8() == true,
                    ownReadThrough = it.value9()!!,
                    otherReadThrough = it.value10()!!,
                    userSeq = it.value11()!!,
                )
            }
    }
}
