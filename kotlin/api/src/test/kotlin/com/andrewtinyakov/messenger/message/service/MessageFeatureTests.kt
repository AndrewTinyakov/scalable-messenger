package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionCommand
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.chat.deletion.model.DeletionTarget
import com.andrewtinyakov.messenger.chat.deletion.service.DeletionService
import com.andrewtinyakov.messenger.chat.grpc.repository.GroupAuthorizationRepository
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.change.service.MessageChangeRetentionService
import com.andrewtinyakov.messenger.message.change.service.MessageMutationService
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.web.payload.MessageResponse
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.crypto.sha256
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertInstanceOf
import org.junit.jupiter.api.Assertions.assertNotEquals
import org.junit.jupiter.api.Assertions.assertNotNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus
import java.time.OffsetDateTime
import java.util.concurrent.TimeUnit

class MessageFeatureTests
    @Autowired
    constructor(
        private val sends: MessageSendService,
        private val batches: MessageSendBatchService,
        private val history: MessageHistoryService,
        private val sendStatusService: SendStatusService,
        private val mutations: MessageMutationService,
        private val deletion: DeletionService,
        private val chats: ChatService,
        private val chatRepository: ChatRepository,
        private val membership: ChatMembershipService,
        private val retention: MessageChangeRetentionService,
        private val authorizations: GroupAuthorizationRepository,
    ) : MessengerIntegrationTest() {
        @Test
        fun `old edits recover independently from creation sequence with versioned paging`() {
            val owner = user("mutation-owner")
            val member = user("mutation-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "first")
            send(owner, chat, "last")
            val edited = mutations.edit(ChatId(chat), UserId(owner), MessageId(first.id), "changed", 1L)
            assertEquals("2", edited.messageVersion)
            assertEquals(first.createdAt, edited.createdAt)
            assertEquals(first.sequence, edited.sequence)
            assertNotNull(edited.editedAt)
            assertEquals(emptyList<Any>(), history.messages(ChatId(chat), UserId(member), 2L, null, 10).messages)
            mutations.edit(ChatId(chat), UserId(owner), MessageId(first.id), "changed again", 2L)
            val page = history.changes(ChatId(chat), UserId(member), 0L, 1)
            assertEquals("2", page.lastRevision)
            assertEquals("1", page.nextRevision)
            assertEquals("3", page.changes.single().message!!.messageVersion)
            assertEquals("changed again", page.changes.single().message!!.body)
            assertEquals("2", history.changes(ChatId(chat), UserId(member), page.nextRevision.toLong(), 1).nextRevision)
            assertEquals("2", history.messages(ChatId(chat), UserId(member), null, null, 10).mutationRevision)
            val events = db.queryForList(
                "SELECT payload->>'mutationRevision' FROM messenger_outbox_events WHERE payload->>'type'='history_changed' AND payload->>'chatId'=? ORDER BY payload->>'mutationRevision'",
                String::class.java,
                chat,
            )
            assertEquals(listOf("1", "2"), events)
        }

        @Test
        fun `author membership and expected version protect mutations`() {
            val owner = user("mutation-policy-owner")
            val member = user("mutation-policy-member")
            val chat = group(owner, member)
            val target = send(member, chat, "member text")
            val forbidden = assertThrows(ApiException::class.java) {
                mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "wrong author", 1L)
            }
            assertEquals(HttpStatus.FORBIDDEN, forbidden.status)
            mutations.edit(ChatId(chat), UserId(member), MessageId(target.id), "new text", 1L)
            val stale = assertThrows(ApiException::class.java) {
                mutations.edit(ChatId(chat), UserId(member), MessageId(target.id), "stale text", 1L)
            }
            assertEquals(HttpStatus.CONFLICT, stale.status)
            membership.removeMember(ChatId(chat), UserId(owner), UserId(member))
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    mutations.delete(ChatId(chat), UserId(member), MessageId(target.id), 2L)
                }.status,
            )
            assertEquals("new text", history.messages(ChatId(chat), UserId(owner), null, null, 10).messages.single().body)
        }

        @Test
        fun `concurrent edits commit one winner and one revision`() {
            val owner = user("edit-race-owner")
            val member = user("edit-race-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "original")
            val results = listOf("left", "right").map { body ->
                concurrently {
                    try {
                        mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), body, 1L)
                        "saved"
                    } catch (error: ApiException) {
                        assertEquals(HttpStatus.CONFLICT, error.status)
                        "conflict"
                    }
                }
            }.map { it.get(10, TimeUnit.SECONDS) }.sorted()
            assertEquals(listOf("conflict", "saved"), results)
            assertEquals("1", history.changes(ChatId(chat), UserId(member), 0L, 100).lastRevision)
        }

        @Test
        fun `replies hydrate current bounded Unicode previews and deleted targets become unavailable`() {
            val owner = user("reply-owner")
            val member = user("reply-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "🦊".repeat(180))
            val request = newId()
            assertEquals(
                CommandResult.SAVED,
                sends.process(command(member, request, "reply", chat = chat).copy(replyToMessageId = target.id)),
            )
            val reply = history.messages(ChatId(chat), UserId(member), null, null, 10).messages.last()
            assertEquals("🦊".repeat(160), reply.replyBody)
            assertEquals(target.id, reply.replyToMessageId)
            mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "edited target", 1L)
            assertEquals("edited target", history.messages(ChatId(chat), UserId(member), null, null, 10).messages.last().replyBody)
            val deleted = mutations.delete(ChatId(chat), UserId(owner), MessageId(target.id), 2L)
            assertEquals("", deleted.body)
            assertEquals("3", deleted.messageVersion)
            assertNotNull(deleted.deletedAt)
            assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE id=?", Int::class.java, target.id))
            val current = history.messages(ChatId(chat), UserId(member), null, null, 10).messages
            assertEquals(null, current.last().replyBody)
            assertEquals(null, current.last().replyDeleted)
            assertEquals(null, current.last().replyVersion)
            assertEquals(
                reply.id,
                history.around(ChatId(chat), UserId(member), MessageId(target.id), target.sequence.toLong(), 1).messages.single().id,
            )
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "resurrect", 3L)
                }.status,
            )
            val invalid = newId()
            sends.process(command(member, invalid, "late reply", chat = chat).copy(replyToMessageId = target.id))
            assertEquals(SendRejectionReason.INVALID_REPLY_TARGET, sendStatusService.status(UserId(member), RequestId(invalid)).reason)
        }

        @Test
        fun `deleting a reply removes its own quote from every hydrated response and outbox event`() {
            val owner = user("deleted-reply-owner")
            val member = user("deleted-reply-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "quoted text")
            sends.process(command(member, newId(), "reply", chat = chat).copy(replyToMessageId = target.id))
            val reply = history.messages(ChatId(chat), UserId(member), null, null, 10).messages.last()
            val deleted = mutations.delete(ChatId(chat), UserId(member), MessageId(reply.id), 1L)
            assertEquals("", deleted.body)
            assertEquals(listOf(target.id), history.messages(ChatId(chat), UserId(member), null, null, 10).messages.map { it.id })
            assertEquals(
                target.id,
                history.around(ChatId(chat), UserId(member), MessageId(reply.id), reply.sequence.toLong(), 1).anchorMessageId,
            )
            val removed = history.changes(ChatId(chat), UserId(member), 0L, 100).changes.single()
            assertEquals(com.andrewtinyakov.messenger.message.web.payload.MessageChangeKind.REMOVED, removed.kind)
            assertEquals(reply.id, removed.messageId)
            assertEquals(null, removed.message)
            assertEquals(0, db.queryForObject("SELECT count(*) FROM messages WHERE id=?", Int::class.java, reply.id))
            assertEquals(
                0,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='history_changed' AND payload->>'chatId'=? AND (jsonb_exists(payload,'body') OR jsonb_exists(payload,'replyBody'))",
                    Int::class.java,
                    chat,
                ),
            )
        }

        @Test
        fun `reply identity is part of deduplication and batch validation preserves sequences`() {
            val owner = user("batch-reply-owner")
            val member = user("batch-reply-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "target")
            val otherChat = group(owner, member)
            val foreign = send(owner, otherChat, "foreign")
            val request = newId()
            val valid = command(member, request, "reply", chat = chat).copy(replyToMessageId = target.id)
            assertEquals(CommandResult.SAVED, sends.process(valid))
            assertEquals(CommandResult.DUPLICATE, sends.process(valid))
            assertEquals(CommandResult.CONFLICT, sends.process(valid.copy(replyToMessageId = foreign.id)))
            val bad = command(member, newId(), "foreign", chat = chat).copy(replyToMessageId = foreign.id)
            val good = command(member, newId(), "batch reply", chat = chat).copy(replyToMessageId = target.id)
            assertEquals(listOf(CommandResult.REJECTED, CommandResult.SAVED), batches.process(listOf(bad, good)))
            assertEquals(
                SendRejectionReason.INVALID_REPLY_TARGET,
                sendStatusService.status(UserId(member), RequestId(bad.requestId)).reason,
            )
            assertEquals(listOf("1", "2", "3"), history.messages(ChatId(chat), UserId(member), null, null, 10).messages.map { it.sequence })
            assertEquals(target.id, history.messages(ChatId(chat), UserId(member), null, null, 10).messages.last().replyToMessageId)
            db.update("UPDATE messages SET reply_to_message_id=? WHERE id=?", foreign.id, target.id)
            assertEquals(null, history.resolve(ChatId(chat), UserId(member), listOf(MessageId(target.id))).messages.single().replyBody)
        }

        @Test
        fun `direct draft replies reject before creating a chat`() {
            val sender = user("draft-reply-sender")
            val recipient = user("draft-reply-recipient")
            val request = command(sender, newId(), "reply", recipient = recipient).copy(replyToMessageId = newId())
            assertEquals(CommandResult.REJECTED, sends.process(request))
            assertEquals(
                SendRejectionReason.INVALID_REPLY_TARGET,
                sendStatusService.status(UserId(sender), RequestId(request.requestId)).reason,
            )
            assertEquals(0, db.queryForObject("SELECT count(*) FROM chat_members WHERE user_id=?", Int::class.java, sender))
        }

        @Test
        fun `around history is bounded contiguous and independent from catch up`() {
            val owner = user("around-owner")
            val member = user("around-member")
            val outsider = user("around-outsider")
            val chat = group(owner, member)
            val rows = (1..7).map { send(owner, chat, "message $it") }
            val center = history.around(ChatId(chat), UserId(member), MessageId(rows[3].id), null, 5)
            assertEquals(listOf("2", "3", "4", "5", "6"), center.messages.map { it.sequence })
            assertEquals(true, center.hasOlder)
            assertEquals(true, center.hasNewer)
            val first = history.around(ChatId(chat), UserId(member), MessageId(rows.first().id), null, 5)
            assertEquals(listOf("1", "2", "3", "4", "5"), first.messages.map { it.sequence })
            assertEquals(false, first.hasOlder)
            val last = history.around(ChatId(chat), UserId(member), MessageId(rows.last().id), null, 5)
            assertEquals(listOf("3", "4", "5", "6", "7"), last.messages.map { it.sequence })
            assertEquals(false, last.hasNewer)
            assertEquals(listOf("6", "7"), history.messages(ChatId(chat), UserId(member), 5L, null, 10).messages.map { it.sequence })
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    history.around(ChatId(chat), UserId(outsider), MessageId(rows[3].id), null, 0)
                }.status,
            )
            val other = group(owner, member)
            assertThrows(ApiException::class.java) { history.around(ChatId(other), UserId(member), MessageId(rows[3].id), null, 5) }
        }

        @Test
        fun `retention advances explicit reset floor without removing current messages`() {
            val owner = user("retention-owner")
            val member = user("retention-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "original")
            mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "old edit", 1L)
            mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "recent edit", 2L)
            db.update("UPDATE message_changes SET changed_at=now()-interval '8 days' WHERE chat_id=? AND revision=1", chat)
            retention.pruneExpiredChanges()
            val reset = history.changes(ChatId(chat), UserId(member), 0L, 100)
            assertEquals(true, reset.resetRequired)
            assertEquals(emptyList<Any>(), reset.changes)
            val retained = history.changes(ChatId(chat), UserId(member), 1L, 100)
            assertEquals(false, retained.resetRequired)
            assertEquals("recent edit", retained.changes.single().message!!.body)
            assertEquals("recent edit", history.messages(ChatId(chat), UserId(member), null, null, 10).messages.single().body)
            assertEquals(true, history.changes(ChatId(chat), UserId(member), 99L, 100).resetRequired)
        }

        @Test
        fun `mutation outbox failure rolls back body version and durable revision`() {
            val owner = user("mutation-rollback-owner")
            val member = user("mutation-rollback-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "original")
            val constraint = "reject_${newId()}"
            db.execute(
                "ALTER TABLE messenger_outbox_events ADD CONSTRAINT \"$constraint\" CHECK (payload->>'type' <> 'history_changed' OR payload->>'chatId' <> '$chat')",
            )
            try {
                assertThrows(RuntimeException::class.java) {
                    mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "lost", 1L)
                }
                assertEquals(target, history.messages(ChatId(chat), UserId(member), null, null, 10).messages.single())
                assertEquals("0", history.changes(ChatId(chat), UserId(member), 0L, 10).lastRevision)
            } finally {
                db.execute("ALTER TABLE messenger_outbox_events DROP CONSTRAINT \"$constraint\"")
            }
            assertEquals("2", mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "saved", 1L).messageVersion)
        }

        @Test
        fun `edit and delete race cannot overwrite a committed newer state`() {
            val owner = user("edit-delete-owner")
            val member = user("edit-delete-member")
            val chat = group(owner, member)
            val target = send(owner, chat, "original")
            val attempts = listOf<() -> MessageResponse>(
                { mutations.edit(ChatId(chat), UserId(owner), MessageId(target.id), "edited", 1L) },
                { mutations.delete(ChatId(chat), UserId(owner), MessageId(target.id), 1L) },
            )
            val results = attempts.map { action ->
                concurrently { runCatching(action) }
            }.map { it.get(10, TimeUnit.SECONDS) }
            val saved = results.filter { it.isSuccess }.single().getOrThrow()
            val rejected = assertInstanceOf(ApiException::class.java, results.filter { it.isFailure }.single().exceptionOrNull())
            val deleted = saved.deletedAt != null
            assertEquals(if (deleted) HttpStatus.NOT_FOUND else HttpStatus.CONFLICT, rejected.status)
            assertEquals("2", saved.messageVersion)
            assertEquals("1", saved.sequence)
            assertEquals(if (deleted) "" else "edited", saved.body)
            assertEquals(
                if (deleted) emptyList<MessageResponse>() else listOf(saved),
                history.messages(ChatId(chat), UserId(member), null, null, 10).messages,
            )
            assertEquals("1", history.changes(ChatId(chat), UserId(member), 0L, 10).lastRevision)
        }

        @Test
        fun `chat deletion outbox failure rolls back visibility and allows retry`() {
            val owner = user("chat-delete-rollback-owner")
            val member = user("chat-delete-rollback-member")
            val chat = group(owner, member)
            send(owner, chat, "kept")
            val constraint = "reject_${newId()}"
            db.execute(
                "ALTER TABLE messenger_outbox_events ADD CONSTRAINT \"$constraint\" " +
                    "CHECK (payload->>'type' <> 'chat_deleted' OR payload->>'chatId' <> '$chat')",
            )
            try {
                assertThrows(RuntimeException::class.java) {
                    deletion.delete(
                        ChatId(chat),
                        UserId(owner),
                        DeletionCommand(RequestId(chat), DeletionScope.EVERYONE, DeletionTarget.CHAT),
                    )
                }
                assertEquals("kept", history.messages(ChatId(chat), UserId(member), null, null, 10).messages.single().body)
                assertEquals(chat, chats.get(ChatId(chat), UserId(member)).id)
            } finally {
                db.execute("ALTER TABLE messenger_outbox_events DROP CONSTRAINT \"$constraint\"")
            }
            deletion.delete(ChatId(chat), UserId(owner), DeletionCommand(RequestId(chat), DeletionScope.EVERYONE, DeletionTarget.CHAT))
            assertThrows(ApiException::class.java) { chats.get(ChatId(chat), UserId(member)) }
        }

        @Test
        fun `either direct participant deletes globally and next draft creates a fresh chat`() {
            val sender = user("delete-direct-sender")
            val recipient = user("delete-direct-recipient")
            val first = command(sender, newId(), "old conversation", recipient = recipient)
            sends.process(first)
            val old = sendStatusService.status(UserId(sender), RequestId(first.requestId)).chatId!!
            deletion.delete(ChatId(old), UserId(recipient), DeletionCommand(RequestId(old), DeletionScope.EVERYONE, DeletionTarget.CHAT))
            deletion.delete(ChatId(old), UserId(sender), DeletionCommand(RequestId(old), DeletionScope.EVERYONE, DeletionTarget.CHAT))
            assertThrows(ApiException::class.java) { history.messages(ChatId(old), UserId(sender), null, null, 10) }
            assertEquals(CommandResult.DUPLICATE, sends.process(first))
            assertEquals(old, sendStatusService.status(UserId(sender), RequestId(first.requestId)).chatId)
            val second = command(sender, newId(), "new conversation", recipient = recipient)
            assertEquals(CommandResult.SAVED, sends.process(second))
            val fresh = sendStatusService.status(UserId(sender), RequestId(second.requestId))
            assertNotEquals(old, fresh.chatId)
            assertEquals("1", fresh.sequence)
            val rejected = command(sender, newId(), "stale send", chat = old)
            sends.process(rejected)
            assertEquals(SendLookupStatus.REJECTED, sendStatusService.status(UserId(sender), RequestId(rejected.requestId)).status)
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_deleted' AND payload->>'chatId'=?",
                    Int::class.java,
                    old,
                ),
            )
        }

        @Test
        fun `only group creator deletes and deletion revokes history mutations and membership grants`() {
            val owner = user("delete-group-owner")
            val member = user("delete-group-member")
            val chat = group(owner, member)
            val target = send(member, chat, "message")
            assertEquals(
                HttpStatus.FORBIDDEN,
                assertThrows(ApiException::class.java) {
                    deletion.delete(
                        ChatId(chat),
                        UserId(member),
                        DeletionCommand(RequestId(chat), DeletionScope.EVERYONE, DeletionTarget.CHAT),
                    )
                }.status,
            )
            val session = sha256(owner)
            db.update(
                "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES (?,?,?,now()+interval '1 hour')",
                session,
                owner,
                "delete-group-device",
            )
            assertEquals(
                setOf(ChatId(chat)),
                authorizations.findAuthorization(SessionId(session), OffsetDateTime.now(), listOf(ChatId(chat)))!!.authorizedChatIds,
            )
            deletion.delete(ChatId(chat), UserId(owner), DeletionCommand(RequestId(chat), DeletionScope.EVERYONE, DeletionTarget.CHAT))
            assertEquals(
                emptySet<ChatId>(),
                authorizations.findAuthorization(SessionId(session), OffsetDateTime.now(), listOf(ChatId(chat)))!!.authorizedChatIds,
            )
            assertEquals(emptyList<Any>(), chats.list(UserId(member), null, 100).chats)
            assertFalse(chatRepository.isMember(ChatId(chat), UserId(member)))
            assertThrows(ApiException::class.java) { mutations.delete(ChatId(chat), UserId(member), MessageId(target.id), 1L) }
            assertThrows(ApiException::class.java) { chats.get(ChatId(chat), UserId(member)) }
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_deleted' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat,
                ),
            )
        }

        private fun group(owner: String, member: String): String =
            chats.createGroup(UserId(owner), "Message features", listOf(member).map(::UserId)).id

        private fun send(owner: String, chat: String, body: String): MessageResponse {
            val request = newId()
            sends.process(command(owner, request, body, chat = chat))
            val id = sendStatusService.status(UserId(owner), RequestId(request)).messageId!!
            return history.around(ChatId(chat), UserId(owner), MessageId(id), null, 1).messages.single()
        }
    }
