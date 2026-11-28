package com.andrewtinyakov.messenger.chat.repository.preferences

import com.andrewtinyakov.messenger.chat.model.ChatPreferences
import com.andrewtinyakov.messenger.infrastructure.database.generated.tables.ChatMembers
import org.jooq.Field
import org.jooq.Record
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType.OFFSETDATETIME
import java.time.OffsetDateTime

val PERMANENT_MUTE: Field<OffsetDateTime> = DSL.cast(DSL.inline("infinity"), OFFSETDATETIME)

class ChatPreferenceFields(
    member: ChatMembers,
) {
    val pinnedRank: Field<Short> = member.PINNED_RANK
    val mutedForever: Field<Boolean> = DSL.coalesce(
        DSL.field(member.MUTED_UNTIL.eq(PERMANENT_MUTE)),
        DSL.inline(false),
    ).`as`("muted_forever")
    val mutedUntil: Field<OffsetDateTime> = DSL.`when`(
        member.MUTED_UNTIL.ne(PERMANENT_MUTE).and(member.MUTED_UNTIL.gt(DSL.currentOffsetDateTime())),
        member.MUTED_UNTIL,
    ).`as`("muted_until_active")
    val markedUnread: Field<Boolean> = DSL.field(member.MARKED_UNREAD_AT.isNotNull).`as`("marked_unread")

    val all: List<Field<*>> = listOf(pinnedRank, mutedForever, mutedUntil, markedUnread)

    fun read(row: Record): ChatPreferences = ChatPreferences(
        pinnedRank = row.get(pinnedRank)?.toInt(),
        mutedUntil = row.get(mutedUntil),
        mutedForever = row.get(mutedForever) == true,
        markedUnread = row.get(markedUnread) == true,
    )
}
