package com.andrewtinyakov.messenger.chat.deletion

import com.andrewtinyakov.messenger.chat.model.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservation
import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseOperation
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.UserId
import org.jooq.DSLContext
import org.jooq.impl.DSL
import org.springframework.stereotype.Repository
import java.time.OffsetDateTime

@Repository
class JooqChatDeletionRepository(
    private val db: DSLContext,
) : ChatDeletionRepository {
    override fun lockForMember(chatId: ChatId, userId: UserId): DeletableChat? =
        DatabaseObservation.query(DatabaseOperation.CHAT_DELETE) {
            db.selectFrom(CHATS).where(CHATS.ID.eq(chatId.value))
                .and(
                    DSL.exists(
                        DSL.selectOne().from(CHAT_MEMBERS)
                            .where(CHAT_MEMBERS.CHAT_ID.eq(chatId.value), CHAT_MEMBERS.USER_ID.eq(userId.value)),
                    ),
                )
                .forNoKeyUpdate().fetchOne()?.let {
                    DeletableChat(ChatKind.valueOf(it.kind!!.name), it.ownerId?.let(::UserId), it.deletedAt != null)
                }
        }

    override fun delete(chatId: ChatId, userId: UserId, now: OffsetDateTime) = DatabaseObservation.query(DatabaseOperation.CHAT_DELETE) {
        check(
            db.update(CHATS).set(CHATS.DELETED_AT, now).set(CHATS.DELETED_BY, userId.value)
                .setNull(CHATS.DIRECT_PAIR_KEY).where(CHATS.ID.eq(chatId.value), CHATS.DELETED_AT.isNull).execute() == 1,
        )
    }
}
