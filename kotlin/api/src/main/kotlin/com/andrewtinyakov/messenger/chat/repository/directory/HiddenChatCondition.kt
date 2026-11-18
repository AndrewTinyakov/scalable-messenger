package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.ChatMembers
import org.jooq.Condition

fun notHidden(member: ChatMembers): Condition =
    member.HIDDEN_THROUGH_SEQUENCE.isNull.or(CHATS.NEXT_SEQUENCE.minus(1L).gt(member.HIDDEN_THROUGH_SEQUENCE))
