package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus

class MessageForwardTests
    @Autowired
    constructor(
        private val sends: MessageSendService,
        private val batches: MessageSendBatchService,
        private val history: MessageHistoryService,
        private val sendStatusService: SendStatusService,
        private val mutations: MessageMutationService,
        private val chats: ChatService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `forwards copy the current source body and keep the original author across hops`() {
            val author = user("forward-author")
            val relay = user("forward-relay")
            val reader = user("forward-reader")
            val source = group(author, relay)
            val target = group(relay, reader)
            val original = send(author, source, "original body")
            mutations.edit(ChatId(source), UserId(author), MessageId(original), "edited body", 1L)
            assertEquals(
                CommandResult.SAVED,
                sends.process(forward(relay, target, source, original, "stale client copy")),
            )
            val copied = history.messages(ChatId(target), UserId(reader), null, null, 10).messages.single()
            assertEquals("edited body", copied.body)
            assertEquals(author, copied.forwardedFromUserId)
            assertEquals(relay, copied.senderId)

            val again = group(reader, author)
            assertEquals(CommandResult.SAVED, sends.process(forward(reader, again, target, copied.id, copied.body)))
            assertEquals(author, history.messages(ChatId(again), UserId(author), null, null, 10).messages.single().forwardedFromUserId)
            val error = assertThrows(ApiException::class.java) {
                mutations.edit(ChatId(target), UserId(relay), MessageId(copied.id), "rewrite", copied.messageVersion.toLong())
            }
            assertEquals(HttpStatus.FORBIDDEN, error.status)
        }

        @Test
        fun `forward sources must be visible to the sender in single and batched sends`() {
            val author = user("forward-private-author")
            val outsider = user("forward-outsider")
            val friend = user("forward-friend")
            val secret = group(author, friend)
            val target = group(outsider, friend)
            val hidden = send(author, secret, "not for outsiders")
            val single = forward(outsider, target, secret, hidden, "guess")
            assertEquals(CommandResult.REJECTED, sends.process(single))
            assertEquals(
                SendRejectionReason.INVALID_FORWARD_SOURCE,
                sendStatusService.status(UserId(outsider), RequestId(single.requestId)).reason,
            )

            val visible = send(friend, target, "visible")
            val batch = listOf(
                forward(friend, target, secret, hidden, "allowed"),
                forward(outsider, target, secret, hidden, "denied"),
                forward(outsider, target, target, visible, "allowed too"),
            )
            assertEquals(listOf(CommandResult.SAVED, CommandResult.REJECTED, CommandResult.SAVED), batches.process(batch))
            val saved = history.messages(ChatId(target), UserId(friend), null, null, 10).messages.drop(1)
            assertEquals(listOf("not for outsiders", "visible"), saved.map { it.body })
            assertEquals(listOf(author, friend), saved.map { it.forwardedFromUserId })
            assertEquals(
                SendRejectionReason.INVALID_FORWARD_SOURCE,
                sendStatusService.status(UserId(outsider), RequestId(batch[1].requestId)).reason,
            )
            assertEquals(CommandResult.DUPLICATE, sends.process(batch[0]))
        }

        private fun forward(sender: String, chat: String, sourceChat: String, sourceMessage: String, body: String) =
            command(sender, newId(), body, chat = chat).copy(forwardFromChatId = sourceChat, forwardFromMessageId = sourceMessage)

        private fun group(owner: String, member: String): String =
            chats.createGroup(UserId(owner), "Forward ${newId()}", listOf(member).map(::UserId)).id

        private fun send(sender: String, chat: String, body: String): String {
            assertEquals(CommandResult.SAVED, sends.process(command(sender, newId(), body, chat = chat)))
            return history.messages(ChatId(chat), UserId(sender), null, null, 50).messages.last().id
        }
    }
