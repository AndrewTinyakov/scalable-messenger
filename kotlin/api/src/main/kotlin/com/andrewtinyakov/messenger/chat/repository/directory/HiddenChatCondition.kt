package com.andrewtinyakov.messenger.chat.repository.directory

import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.ChatMembers
import org.jooq.Condition

fun notHidden(member: ChatMembers): Condition =
    member.HIDDEN_THROUGH_SEQUENCE.isNull.or(CHATS.LAST_MESSAGE_SEQUENCE.gt(member.HIDDEN_THROUGH_SEQUENCE))

fun hidden(member: ChatMembers): Condition =
    member.HIDDEN_THROUGH_SEQUENCE.isNotNull.and(CHATS.LAST_MESSAGE_SEQUENCE.le(member.HIDDEN_THROUGH_SEQUENCE))
