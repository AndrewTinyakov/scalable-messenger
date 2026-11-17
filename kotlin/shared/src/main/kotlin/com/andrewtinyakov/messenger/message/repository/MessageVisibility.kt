package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import org.jooq.Condition
import org.jooq.Field
import org.jooq.impl.DSL

fun visibleMessage(chatId: ChatId, userId: UserId, sequence: Field<Long>): Condition = DSL.exists(
    DSL.selectOne().from(CHAT_MEMBERS).join(CHATS).on(CHATS.ID.eq(CHAT_MEMBERS.CHAT_ID))
        .where(
            CHAT_MEMBERS.CHAT_ID.eq(chatId.value),
            CHAT_MEMBERS.USER_ID.eq(userId.value),
            CHATS.DELETED_AT.isNull,
            sequence.gt(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE),
            sequence.gt(CHATS.CLEARED_THROUGH_SEQUENCE),
        ),
).and(
    sequence.gt(
        DSL.coalesce(
            DSL.select(HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE).from(HIDDEN_MESSAGE_RANGES)
                .where(
                    HIDDEN_MESSAGE_RANGES.CHAT_ID.eq(chatId.value),
                    HIDDEN_MESSAGE_RANGES.USER_ID.eq(userId.value),
                    HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.lt(sequence),
                )
                .orderBy(HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE.desc()).limit(1).asField<Long>(),
            DSL.inline(0L),
        ),
    ),
)
