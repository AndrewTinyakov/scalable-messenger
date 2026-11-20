package com.andrewtinyakov.messenger.message.repository

import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGE_CHANGES
import org.jooq.Field
import org.jooq.impl.DSL

fun mutationSeq(chatId: ChatId): Field<Long> = DSL.greatest(
    CHATS.MUTATION_FLOOR,
    DSL.coalesce(
        DSL.select(DSL.max(MESSAGE_CHANGES.SEQ)).from(MESSAGE_CHANGES).where(MESSAGE_CHANGES.CHAT_ID.eq(chatId.value)).asField<Long>(),
        DSL.inline(0L),
    ),
)
