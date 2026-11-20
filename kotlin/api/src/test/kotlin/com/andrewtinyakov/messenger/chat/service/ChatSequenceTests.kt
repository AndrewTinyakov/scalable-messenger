package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.service.DeletionService
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.model.pin.PinScope
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.service.MessageMutationService
import com.andrewtinyakov.messenger.message.service.MessagePinService
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.message.service.MessageSendStatusService
import com.andrewtinyakov.messenger.read.service.ReadService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus
import tools.jackson.databind.JsonNode
import tools.jackson.databind.ObjectMapper
import java.time.OffsetDateTime

class ChatSequenceTests
    @Autowired
    constructor(
        private val chats: ChatService,
        private val membership: ChatMembershipService,
        private val preferences: ChatPreferencesService,
        private val chatState: ChatStateService,
        private val mutations: MessageMutationService,
        private val pins: MessagePinService,
        private val deletions: DeletionService,
        private val reads: ReadService,
        private val sends: MessageSendService,
        private val sendStatus: MessageSendStatusService,
        private val mapper: ObjectMapper,
        private val history: MessageHistoryService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `each shared write takes one chat sequence and its hint carries it`() {
            val owner = user("seq-shared-owner")
            val member = user("seq-shared-member")
            val extra = user("seq-shared-extra")
            val chat = group(owner, member)
            val first = send(owner, chat, "first")
            val second = send(owner, chat, "second")
            assertEquals(2, head(chat))
            val activity = activityAt(chat)

            mutations.edit(ChatId(chat), UserId(owner), first, "edited", 1L)
            assertEquals(3, head(chat))
            assertEquals("3", latest(chat, "history_changed", "group:$chat").path("seq").stringValue())

            pins.pin(ChatId(chat), UserId(owner), second, PinScope.EVERYONE)
            assertEquals(4, head(chat))
            assertEquals("4", latest(chat, "pins_changed", "group:$chat").path("seq").stringValue())
            assertEquals(4, column(chat, "pins_seq"))

            deletions.deleteMessages(ChatId(chat), UserId(owner), RequestId(newId()), DeletionScope.EVERYONE, listOf(first, second))
            assertEquals(5, head(chat))
            assertEquals(
                listOf(5L, 5L),
                db.queryForList("SELECT seq FROM message_changes WHERE chat_id=? AND kind='REMOVED'", Long::class.java, chat),
            )
            assertEquals("5", latest(chat, "history_changed", "group:$chat").path("seq").stringValue())
            assertEquals(5, column(chat, "pins_seq"), "deleting a pinned message changes the shared pins")

            chats.addMembers(ChatId(chat), UserId(owner), listOf(UserId(extra)))
            assertEquals(6, head(chat))
            assertEquals("6", latest(chat, "membership_changed", "group:$chat").path("seq").stringValue())
            assertEquals("1", latest(chat, "chat_created", "user:$extra").path("userSeq").stringValue())

            membership.removeMember(ChatId(chat), UserId(owner), UserId(extra))
            assertEquals(7, head(chat))
            val sharedRemoval = latest(chat, "member_removed", "group:$chat")
            assertEquals("7", sharedRemoval.path("seq").stringValue())
            assertFalse(sharedRemoval.has("userSeq"))
            val ownRemoval = latest(chat, "member_removed", "user:$extra")
            assertEquals("2", ownRemoval.path("userSeq").stringValue())
            assertFalse(ownRemoval.has("seq"))

            deletions.clearHistory(ChatId(chat), UserId(owner), RequestId(newId()), DeletionScope.EVERYONE)
            assertEquals(8, head(chat))
            assertEquals("8", latest(chat, "history_changed", "group:$chat").path("seq").stringValue())

            assertEquals(activity, activityAt(chat), "only sends move chat activity")
            assertEquals(0, memberSeq(chat, owner), "shared writes leave member sequences alone")
            assertEquals(8, chatState.state(ChatId(chat), UserId(member), minSeq = null).lastSeq.toLong())
        }

        @Test
        fun `private writes advance only the member sequence and reach only the account`() {
            val owner = user("seq-private-owner")
            val member = user("seq-private-member")
            val chat = group(owner, member)
            val mine = send(owner, chat, "mine")
            send(member, chat, "theirs")

            preferences.mute(ChatId(chat), UserId(member), null)
            assertEquals("1", latest(chat, "chat_preferences_changed", "user:$member").path("memberSeq").stringValue())
            preferences.markUnread(ChatId(chat), UserId(member), true)
            deletions.deleteMessages(ChatId(chat), UserId(member), RequestId(newId()), DeletionScope.SELF, listOf(mine))
            assertEquals("3", latest(chat, "history_changed", "user:$member").path("memberSeq").stringValue())
            reads.advance(ChatId(chat), UserId(member), 2L)
            val ownRead = latest(chat, "reads_changed", "user:$member")
            assertEquals("4", ownRead.path("memberSeq").stringValue())
            assertFalse(latest(chat, "reads_changed", "group:$chat").has("memberSeq"), "other members' receipts take no number")
            deletions.clearHistory(ChatId(chat), UserId(member), RequestId(newId()), DeletionScope.SELF)
            assertEquals(5, memberSeq(chat, member))

            assertEquals(2, head(chat))
            assertEquals(0, memberSeq(chat, owner))
            assertEquals(
                0,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=? AND room=? AND payload->>'type' IN " +
                        "('chat_preferences_changed','history_changed')",
                    Int::class.java,
                    chat,
                    "group:$chat",
                ),
            )
        }

        @Test
        fun `personal pins in a direct chat number the owner's member sequence`() {
            val owner = user("seq-direct-owner")
            val peer = user("seq-direct-peer")
            val request = newId()
            sends.process(command(owner, request, "hello", recipient = peer))
            val status = sendStatus.status(UserId(owner), RequestId(request))
            val chat = status.chatId!!
            val created = db.queryForList(
                "SELECT payload->>'userSeq' FROM messenger_outbox_events WHERE payload->>'type'='chat_created' AND payload->>'chatId'=?",
                String::class.java,
                chat,
            )
            assertEquals(listOf("1", "1"), created)

            pins.pin(ChatId(chat), UserId(owner), MessageId(status.messageId!!), PinScope.SELF)
            assertEquals(1, memberSeq(chat, owner))
            assertEquals(0, memberSeq(chat, peer))
            assertEquals(1, head(chat))
            assertEquals(0, column(chat, "pins_seq"))
            val event = latest(chat, "pins_changed", "user:$owner")
            assertEquals("1", event.path("memberSeq").stringValue())
            assertFalse(event.has("seq"))
        }

        @Test
        fun `chat pin order takes one account sequence per announced chat`() {
            val owner = user("seq-account-owner")
            val member = user("seq-account-member")
            val first = group(owner, member)
            val second = group(owner, member)
            assertEquals(2, userSeq(member))

            preferences.pin(ChatId(first), UserId(member))
            preferences.pin(ChatId(second), UserId(member))
            assertEquals(5, userSeq(member))
            val numbers = db.queryForList(
                "SELECT payload->>'userSeq' FROM messenger_outbox_events WHERE room=? AND payload->>'type'='chat_preferences_changed' " +
                    "ORDER BY (payload->>'userSeq')::bigint",
                String::class.java,
                "user:$member",
            )
            assertEquals(listOf("3", "4", "5"), numbers)
            assertEquals("5", chatState.state(ChatId(first), UserId(member), minSeq = null).userSeq)
        }

        @Test
        fun `state returns every counter from one read and hides chats from non-members`() {
            val owner = user("seq-state-owner")
            val member = user("seq-state-member")
            val outsider = user("seq-state-outsider")
            val chat = group(owner, member)
            send(owner, chat, "one")
            val second = send(owner, chat, "two")
            pins.pin(ChatId(chat), UserId(owner), second, PinScope.EVERYONE)
            reads.advance(ChatId(chat), UserId(owner), 2L)
            reads.advance(ChatId(chat), UserId(member), 1L)
            deletions.clearHistory(ChatId(chat), UserId(member), RequestId(newId()), DeletionScope.SELF)

            val state = chatState.state(ChatId(chat), UserId(member), minSeq = 99L)
            assertEquals("3", state.lastSeq)
            assertEquals("3", state.pinsSeq)
            assertEquals("0", state.mutationFloor)
            assertEquals("2", state.memberSeq)
            assertEquals("3", state.clearedThroughSequence)
            assertEquals("0", state.globalClearedThroughSequence)
            assertFalse(state.hidden)
            assertEquals("1", state.ownReadThrough)
            assertEquals("2", state.otherReadThrough)
            assertEquals("1", state.userSeq)

            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) { chatState.state(ChatId(chat), UserId(outsider), minSeq = null) }.status,
            )
        }

        @Test
        fun `a hidden chat resurfaces on a later message but not on a later shared event`() {
            val owner = user("seq-hidden-owner")
            val member = user("seq-hidden-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "before")
            deletions.deleteChat(ChatId(chat), UserId(member), RequestId(newId()), DeletionScope.SELF)
            assertTrue(chatState.state(ChatId(chat), UserId(member), minSeq = null).hidden)

            mutations.edit(ChatId(chat), UserId(owner), first, "edited", 1L)
            assertTrue(chatState.state(ChatId(chat), UserId(member), minSeq = null).hidden)
            assertNull(chats.list(UserId(member), null, 50).chats.firstOrNull { it.id == chat })

            send(owner, chat, "after")
            assertFalse(chatState.state(ChatId(chat), UserId(member), minSeq = null).hidden)
            assertEquals(chat, chats.list(UserId(member), null, 50).chats.single { it.id == chat }.id)
        }

        @Test
        fun `a chat resurfaced by a new message stays visible after that message is deleted`() {
            val owner = user("seq-resurface-owner")
            val member = user("seq-resurface-member")
            val chat = group(owner, member)
            send(owner, chat, "before")
            deletions.deleteChat(ChatId(chat), UserId(member), RequestId(newId()), DeletionScope.SELF)
            assertFalse(listed(member, chat))

            val resurfacing = send(owner, chat, "after")
            assertTrue(listed(member, chat))
            deletions.deleteMessages(ChatId(chat), UserId(owner), RequestId(newId()), DeletionScope.EVERYONE, listOf(resurfacing))
            assertTrue(listed(member, chat))
        }

        @Test
        fun `change pages end on a whole change and never exceed the limit`() {
            val owner = user("seq-paging-owner")
            val member = user("seq-paging-member")
            val chat = group(owner, member)
            val edited = send(owner, chat, "edited")
            val removed = (1..4).map { send(owner, chat, "removed $it") }
            mutations.edit(ChatId(chat), UserId(owner), edited, "edited again", 1L)
            deletions.deleteMessages(ChatId(chat), UserId(owner), RequestId(newId()), DeletionScope.EVERYONE, removed)

            val first = history.changes(ChatId(chat), UserId(owner), after = 0, limit = 3)
            assertEquals(listOf("6"), first.changes.map { it.seq })
            val second = history.changes(ChatId(chat), UserId(owner), after = first.nextSeq.toLong(), limit = 4)
            assertEquals(List(4) { "7" }, second.changes.map { it.seq })
        }

        @Test
        fun `only visibility changes move the visibility sequence and only personal pins move the personal pin sequence`() {
            val owner = user("seq-split-owner")
            val member = user("seq-split-member")
            val chat = group(owner, member)
            val first = send(owner, chat, "first")
            send(owner, chat, "second")

            fun state() = chatState.state(ChatId(chat), UserId(member), minSeq = null)

            reads.advance(ChatId(chat), UserId(member), 1L)
            preferences.mute(ChatId(chat), UserId(member), null)
            assertEquals("2", state().memberSeq)
            assertEquals("0", state().visibilitySeq)
            assertEquals("0", state().memberPinsSeq)

            deletions.deleteMessages(ChatId(chat), UserId(member), RequestId(newId()), DeletionScope.SELF, listOf(first))
            assertEquals("3", state().memberSeq)
            assertEquals("3", state().visibilitySeq)
            assertEquals("3", history.messages(ChatId(chat), UserId(member), null, null, 10).visibilitySeq)
        }

        private fun group(owner: String, member: String): String = chats.createGroup(UserId(owner), "Sequences", listOf(UserId(member))).id

        private fun send(sender: String, chat: String, body: String): MessageId {
            val request = newId()
            sends.process(command(sender, request, body, chat = chat))
            return MessageId(sendStatus.status(UserId(sender), RequestId(request)).messageId!!)
        }

        private fun listed(user: String, chat: String): Boolean =
            chats.list(UserId(user), null, 100).chats.any { it.id == chat }

        private fun head(chat: String): Long = column(chat, "next_sequence") - 1

        private fun column(chat: String, name: String): Long = db.queryForObject(
            "SELECT $name FROM chats WHERE id=?",
            Long::class.java,
            chat,
        )!!

        private fun activityAt(chat: String): OffsetDateTime? =
            db.queryForObject("SELECT last_activity_at FROM chats WHERE id=?", OffsetDateTime::class.java, chat)

        private fun memberSeq(chat: String, user: String): Long =
            db.queryForObject("SELECT member_seq FROM chat_members WHERE chat_id=? AND user_id=?", Long::class.java, chat, user)!!

        private fun userSeq(user: String): Long = db.queryForObject("SELECT event_seq FROM users WHERE id=?", Long::class.java, user)!!

        private fun latest(chat: String, type: String, room: String): JsonNode = mapper.readTree(
            db.queryForList(
                "SELECT payload::text FROM messenger_outbox_events WHERE payload->>'chatId'=? AND payload->>'type'=? AND room=? " +
                    "ORDER BY created_at DESC, id DESC LIMIT 1",
                String::class.java,
                chat,
                type,
                room,
            ).single(),
        )
    }
