package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus

class MessageHistoryServiceTests
    @Autowired
    constructor(
        private val service: MessageSendService,
        private val messageRepository: MessageRepository,
        private val chatService: ChatService,
        private val chatRepository: ChatRepository,
        private val chatMembershipService: ChatMembershipService,
        private val messageHistoryService: MessageHistoryService,
        private val messageSendStatusService: MessageSendStatusService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `batch send status preserves order and hides other users results`() {
            val sender = user("batch-status-sender")
            val recipient = user("batch-status-recipient")
            val other = user("batch-status-other")
            val saved = newId()
            val rejected = newId()
            val otherRequest = newId()
            val unknown = newId()
            service.process(command(sender, saved, "hello", recipient = recipient))
            service.process(command(sender, rejected, "hello", recipient = newId()))
            service.process(command(other, otherRequest, "hello", recipient = recipient))

            val statuses = messageSendStatusService.statuses(
                UserId(sender),
                listOf(saved, rejected, otherRequest, unknown).map(::RequestId),
            ).results
            assertEquals(listOf(saved, rejected, otherRequest, unknown), statuses.map { it.requestId })
            assertEquals(
                listOf(SendLookupStatus.SAVED, SendLookupStatus.REJECTED, SendLookupStatus.UNKNOWN, SendLookupStatus.UNKNOWN),
                statuses.map {
                    it.result.status
                },
            )
            assertEquals(null, statuses[2].result.chatId)
            assertThrows(RuntimeException::class.java) {
                messageSendStatusService.statuses(UserId(sender), listOf(saved, saved).map(::RequestId))
            }
        }

        @Test
        fun `SQL history reads recheck current membership`() {
            val owner = user("history-access-owner")
            val member = user("history-access-member")
            val outsider = user("history-access-outsider")
            val chat = chatService.createGroup(UserId(owner), "History access", listOf(member).map(::UserId))
            service.process(command(owner, newId(), "private history", chat = chat.id))

            assertEquals(
                listOf("private history"),
                messageRepository.findMessagesAfter(ChatId(chat.id), UserId(member), 0, 10).map {
                    it.body
                },
            )
            assertEquals(emptyList<Any>(), messageRepository.findMessagesBefore(ChatId(chat.id), UserId(outsider), null, 10))

            assertTrue(chatRepository.isMember(ChatId(chat.id), UserId(member)))
            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))

            assertEquals(emptyList<Any>(), messageRepository.findMessagesAfter(ChatId(chat.id), UserId(member), 0, 10))
            assertEquals(emptyList<Any>(), messageRepository.findMessagesBefore(ChatId(chat.id), UserId(member), null, 10))
            assertThrows(ApiException::class.java) { messageHistoryService.messages(ChatId(chat.id), UserId(member), null, null, 10) }
        }

        @Test
        fun `history preserves membership error precedence for empty pages and invalid inputs`() {
            val owner = user("history-precedence-owner")
            val member = user("history-precedence-member")
            val outsider = user("history-precedence-outsider")
            val chat = chatService.createGroup(UserId(owner), "Empty history", listOf(member).map(::UserId))
            val chatId = ChatId(chat.id)

            assertEquals(emptyList<Any>(), messageHistoryService.messages(chatId, UserId(member), null, null, 10).messages)
            listOf(chatId, ChatId(newId())).forEach { hidden ->
                val valid = assertThrows(ApiException::class.java) {
                    messageHistoryService.messages(hidden, UserId(outsider), null, null, 10)
                }
                val invalid = assertThrows(ApiException::class.java) {
                    messageHistoryService.messages(hidden, UserId(outsider), null, null, 0)
                }
                assertEquals(HttpStatus.NOT_FOUND, valid.status)
                assertEquals(HttpStatus.NOT_FOUND, invalid.status)
            }
            val invalidMemberRequest = assertThrows(ApiException::class.java) {
                messageHistoryService.messages(chatId, UserId(member), null, null, 0)
            }
            assertEquals(HttpStatus.BAD_REQUEST, invalidMemberRequest.status)
        }

        @Test
        fun `history cursors stay within saved history`() {
            val owner = user("canonical-history-owner")
            val member = user("canonical-history-member")
            val chat = chatService.createGroup(UserId(owner), "Canonical", listOf(member).map(::UserId))
            val chatId = ChatId(chat.id)
            val userId = UserId(owner)

            assertEquals("0", messageHistoryService.messages(chatId, userId, 0L, null, 10).nextSequence)
            assertEquals("1", messageHistoryService.messages(chatId, userId, null, 1L, 10).nextSequence)
            assertThrows(ApiException::class.java) { messageHistoryService.messages(chatId, userId, 9223372036854775807L, null, 10) }
        }

        @Test
        fun `history defaults to latest and pages backward without breaking forward catch up`() {
            val owner = user("history-owner")
            val member = user("history-member")
            val chat = chatService.createGroup(UserId(owner), "History", listOf(member).map(::UserId))
            (1..5).forEach { service.process(command(owner, newId(), "message $it", chat = chat.id)) }

            val latest = messageHistoryService.messages(ChatId(chat.id), UserId(owner), null, null, 2)
            assertEquals(listOf("4", "5"), latest.messages.map { it.sequence })
            assertEquals("4", latest.nextSequence)
            assertEquals(true, latest.hasMore)

            val older = messageHistoryService.messages(ChatId(chat.id), UserId(owner), null, latest.nextSequence.toLong(), 2)
            assertEquals(listOf("2", "3"), older.messages.map { it.sequence })
            assertEquals("2", older.nextSequence)
            assertEquals(true, older.hasMore)

            val oldest = messageHistoryService.messages(ChatId(chat.id), UserId(owner), null, older.nextSequence.toLong(), 2)
            assertEquals(listOf("1"), oldest.messages.map { it.sequence })
            assertEquals(false, oldest.hasMore)

            val catchup = messageHistoryService.messages(ChatId(chat.id), UserId(owner), 3L, null, 2)
            assertEquals(listOf("4", "5"), catchup.messages.map { it.sequence })
            assertEquals("5", catchup.nextSequence)
            assertEquals(false, catchup.hasMore)
        }
    }
