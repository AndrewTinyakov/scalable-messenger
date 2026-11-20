package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.ChatMembers
import org.jooq.Condition
import org.jooq.impl.DSL

fun notHidden(member: ChatMembers): Condition = member.HIDDEN_THROUGH_SEQUENCE.isNull.or(savedAboveHideCutoff(member))

fun hidden(member: ChatMembers): Condition = member.HIDDEN_THROUGH_SEQUENCE.isNotNull.andNot(savedAboveHideCutoff(member))

private fun savedAboveHideCutoff(member: ChatMembers): Condition {
    val later = MESSAGES.`as`("resurfacing")
    return DSL.exists(
        DSL.selectOne().from(later)
            .where(later.CHAT_ID.eq(member.CHAT_ID), later.SEQUENCE.gt(member.HIDDEN_THROUGH_SEQUENCE)),
    )
}
