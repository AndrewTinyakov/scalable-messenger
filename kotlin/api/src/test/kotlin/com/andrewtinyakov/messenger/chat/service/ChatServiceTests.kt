package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.MemberChatDetails
import com.andrewtinyakov.messenger.chat.web.payload.AddGroupMembersRequest
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ChatServiceTests
    @Autowired
    constructor(
        private val chatService: ChatService,
        private val chatRepository: ChatRepository,
        private val chatMembershipService: ChatMembershipService,
        private val outboxRepository: OutboxRepository,
        private val mapper: ObjectMapper,
        private val tx: TransactionTemplate,
        private val messageSendService: MessageSendService,
        private val messageHistoryService: MessageHistoryService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `chat summaries include sender names and obey viewer visibility across sequence gaps`() {
            val owner = user("summary-owner")
            val member = user("summary-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Summary", listOf(member)))
            assertEquals(null, chat.lastMessage)
            messageSendService.process(command(member, newId(), "Earlier", chat = chat.id))
            messageSendService.process(command(owner, newId(), "x".repeat(180), chat = chat.id))
            val listed = chatService.list(UserId(owner), null, 100).chats.single { it.id == chat.id }
            assertEquals(emptyList<Any>(), listed.members)
            assertEquals("summary-owner", listed.lastMessage!!.senderUsername)
            assertEquals("2", listed.lastMessage.sequence)
            assertEquals("x".repeat(160), listed.lastMessage.bodyPreview)
            assertEquals(false, listed.lastMessage.deleted)
            assertEquals(listed.lastMessage, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            db.update("INSERT INTO hidden_message_ranges(chat_id,user_id,after_sequence,through_sequence) VALUES (?,?,1,2)", chat.id, owner)
            assertEquals("1", chatService.get(ChatId(chat.id), UserId(owner)).lastMessage!!.sequence)
            assertEquals("2", chatService.get(ChatId(chat.id), UserId(member)).lastMessage!!.sequence)
            db.update("DELETE FROM messages WHERE chat_id=? AND sequence=1", chat.id)
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            db.update("UPDATE chat_members SET cleared_through_sequence=2 WHERE chat_id=? AND user_id=?", chat.id, member)
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(member)).lastMessage)
            db.update("UPDATE chat_members SET hidden_through_sequence=2 WHERE chat_id=? AND user_id=?", chat.id, owner)
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            messageSendService.process(command(member, newId(), "Visible again", chat = chat.id))
            assertEquals("3", chatService.get(ChatId(chat.id), UserId(owner)).lastMessage!!.sequence)
            db.update("UPDATE chats SET cleared_through_sequence=3 WHERE id=?", chat.id)
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))
            assertThrows(ApiException::class.java) { chatService.get(ChatId(chat.id), UserId(member)) }
        }

        @Test
        fun `chat reads retain one authorized snapshot during member removal`() {
            val owner = user("snapshot-chat-owner")
            val member = user("snapshot-chat-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Snapshot", listOf(member)))
            val removingRepository = object : ChatRepository by chatRepository {
                override fun findMemberDetails(chatId: ChatId, userId: UserId): MemberChatDetails? {
                    val snapshot = chatRepository.findMemberDetails(chatId = chatId, userId = userId)
                    concurrently { chatMembershipService.removeMember(chatId, UserId(owner), UserId(member)) }.join()
                    return snapshot
                }
            }
            val concurrentReads = ChatService(
                repository = removingRepository,
                outboxRepository = outboxRepository,
                mapper = mapper,
                tx = tx,
            )

            val snapshot = concurrentReads.get(ChatId(chat.id), UserId(member))

            assertEquals(2, snapshot.memberCount)
            assertEquals(setOf(owner, member), snapshot.members.map { it.id }.toSet())
            assertThrows(ApiException::class.java) { chatService.get(ChatId(chat.id), UserId(member)) }
        }

        @Test
        fun `failed group creation outbox batch rolls back the chat and members`() {
            val owner = user("batch-rollback-owner")
            val member = user("batch-rollback-member")
            var attempted: ChatId? = null
            val invalidEvents = object : ChatRepository by chatRepository {
                override fun insertGroupWithMembersAndEvents(
                    id: ChatId,
                    name: String,
                    ownerId: UserId,
                    members: List<UserId>,
                    events: List<OutboxMessage>,
                ) {
                    attempted = id
                    chatRepository.insertGroupWithMembersAndEvents(
                        id = id,
                        name = name,
                        ownerId = ownerId,
                        members = members,
                        events = listOf(events.first(), events.last().copy(id = events.first().id)),
                    )
                }
            }
            val failing = ChatService(repository = invalidEvents, outboxRepository = outboxRepository, mapper = mapper, tx = tx)

            assertThrows(RuntimeException::class.java) {
                failing.createGroup(UserId(owner), CreateGroupChatRequest("Rollback", listOf(member)))
            }

            val chatId = requireNotNull(attempted)
            assertEquals(null, chatRepository.findById(chatId))
            assertEquals(emptyList<Any>(), chatRepository.findMemberIds(chatId))
            assertEquals(
                0,
                db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?", Int::class.java, chatId.value),
            )
        }

        @Test
        fun `multiple initial and added member chunks keep exact stored counts`() {
            val owner = user("chunk-owner")
            val members = (1..501).map { user("chunk-initial-$it") }
            val additions = (1..501).map { user("chunk-addition-$it") }

            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Chunks", members))
            assertEquals(502, chat.memberCount)
            assertEquals(50, chat.members.size)
            assertEquals((members + owner).sorted().take(50), chat.members.map { it.id })

            chatService.addMembers(ChatId(chat.id), UserId(owner), AddGroupMembersRequest(additions))

            assertEquals(1003, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(1003, chatRepository.findMemberIds(ChatId(chat.id)).size)
            assertEquals(
                1003,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
        }

        @Test
        fun `missing and repeated removal do not change counters or publish events`() {
            val owner = user("noop-remove-owner")
            val member = user("noop-remove-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Removal", listOf(member)))
            val chatId = ChatId(chat.id)

            assertThrows(ApiException::class.java) { chatMembershipService.removeMember(chatId, UserId(owner), UserId(newId())) }
            assertEquals(2, chatService.get(chatId, UserId(owner)).memberCount)
            chatMembershipService.removeMember(chatId, UserId(owner), UserId(member))
            assertThrows(ApiException::class.java) { chatMembershipService.removeMember(chatId, UserId(owner), UserId(member)) }

            assertEquals(1, chatService.get(chatId, UserId(owner)).memberCount)
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='member_removed' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
        }

        @Test
        fun `failed removal events roll back membership and its counter`() {
            val owner = user("remove-rollback-owner")
            val member = user("remove-rollback-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Rollback removal", listOf(member)))
            val failingOutbox = object : OutboxRepository by outboxRepository {
                override fun enqueue(messages: Collection<OutboxMessage>) {
                    outboxRepository.enqueue(messages.map { it.copy(id = messages.first().id) })
                }
            }
            val failing = ChatMembershipService(repository = chatRepository, tx = tx, outboxRepository = failingOutbox, mapper = mapper)

            assertThrows(RuntimeException::class.java) { failing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }

            assertEquals(2, chatService.get(ChatId(chat.id), UserId(member)).memberCount)
            assertEquals(
                0,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='member_removed' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
        }

        @Test
        fun `concurrent add and removal preserve the exact membership count`() {
            val owner = user("concurrent-add-owner")
            val member = user("concurrent-add-member")
            val addition = user("concurrent-add-new")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Concurrent", listOf(member)))
            val removed = CountDownLatch(1)
            val release = CountDownLatch(1)
            val pausedRepository = object : ChatRepository by chatRepository {
                override fun deleteMemberAndDecrementCount(chatId: ChatId, userId: UserId): Boolean {
                    val result = chatRepository.deleteMemberAndDecrementCount(chatId = chatId, userId = userId)
                    removed.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    return result
                }
            }
            val removing =
                ChatMembershipService(repository = pausedRepository, tx = tx, outboxRepository = outboxRepository, mapper = mapper)
            val removal = concurrently { removing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }
            try {
                assertTrue(removed.await(10, TimeUnit.SECONDS))
                val addingStarted = CountDownLatch(1)
                val addingRepository = object : ChatRepository by chatRepository {
                    override fun findByIdForUpdate(chatId: ChatId): Chat? {
                        addingStarted.countDown()
                        return chatRepository.findByIdForUpdate(chatId = chatId)
                    }
                }
                val addingService =
                    ChatService(repository = addingRepository, outboxRepository = outboxRepository, mapper = mapper, tx = tx)
                val adding = concurrently {
                    addingService.addMembers(ChatId(chat.id), UserId(owner), AddGroupMembersRequest(listOf(addition)))
                }
                assertTrue(addingStarted.await(10, TimeUnit.SECONDS))
                release.countDown()
                CompletableFuture.allOf(removal, adding).get(10, TimeUnit.SECONDS)
            } finally {
                release.countDown()
            }

            val current = chatService.get(ChatId(chat.id), UserId(owner))
            assertEquals(2, current.memberCount)
            assertEquals(setOf(owner, addition), current.members.map { it.id }.toSet())
        }

        @Test
        fun `concurrent removals delete and notify only once`() {
            val owner = user("concurrent-remove-owner")
            val member = user("concurrent-remove-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Concurrent removal", listOf(member)))
            val readers = CountDownLatch(2)
            val simultaneous = object : ChatRepository by chatRepository {
                override fun findById(chatId: ChatId): Chat? {
                    val found = chatRepository.findById(chatId = chatId)
                    readers.countDown()
                    check(readers.await(10, TimeUnit.SECONDS))
                    return found
                }
            }
            val removing = ChatMembershipService(repository = simultaneous, tx = tx, outboxRepository = outboxRepository, mapper = mapper)
            val removals = (1..2).map {
                concurrently {
                    runCatching { removing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }
                }
            }.map { it.get(10, TimeUnit.SECONDS) }

            assertEquals(1, removals.count { it.isSuccess })
            assertEquals(1, removals.count { it.exceptionOrNull() is ApiException })
            assertEquals(1, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='member_removed' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
        }

        @Test
        fun `send waiting behind removal rejects without allocating a sequence`() {
            val owner = user("remove-before-send-owner")
            val member = user("remove-before-send-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Remove before send", listOf(member)))
            val request = newId()
            val deleted = CountDownLatch(1)
            val release = CountDownLatch(1)
            val removalBackend = CompletableFuture<Int>()
            val paused = object : ChatRepository by chatRepository {
                override fun deleteMemberAndDecrementCount(chatId: ChatId, userId: UserId): Boolean {
                    val result = chatRepository.deleteMemberAndDecrementCount(chatId = chatId, userId = userId)
                    removalBackend.complete(db.queryForObject("SELECT pg_backend_pid()", Int::class.java)!!)
                    deleted.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    return result
                }
            }
            val removing = ChatMembershipService(repository = paused, tx = tx, outboxRepository = outboxRepository, mapper = mapper)
            val removal = concurrently { removing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }
            try {
                assertTrue(deleted.await(10, TimeUnit.SECONDS))
                val send = concurrently {
                    messageSendService.process(command(member, request, "racing removal", chat = chat.id))
                }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                while (
                    db.queryForObject(
                        "SELECT count(*) FROM pg_stat_activity WHERE ? = ANY(pg_blocking_pids(pid))",
                        Int::class.java,
                        removalBackend.get(10, TimeUnit.SECONDS),
                    ) == 0
                ) {
                    check(System.nanoTime() < deadline) { "Send did not wait for the removal transaction" }
                    Thread.sleep(10)
                }
                release.countDown()
                assertEquals(CommandResult.REJECTED, send.get(10, TimeUnit.SECONDS))
                removal.get(10, TimeUnit.SECONDS)
            } finally {
                release.countDown()
            }

            assertEquals(SendRejectionReason.NOT_A_MEMBER, messageHistoryService.status(UserId(member), RequestId(request)).reason)
            assertEquals(0L, chatRepository.findById(ChatId(chat.id))!!.lastSequence)
        }

        @Test
        fun `send holding chat lock commits its message event before removal`() {
            val owner = user("send-before-remove-owner")
            val member = user("send-before-remove-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Send before remove", listOf(member)))
            val locked = CountDownLatch(1)
            val removalStarted = CountDownLatch(1)
            val release = CountDownLatch(1)
            val request = newId()
            val sending = concurrently {
                tx.execute {
                    chatRepository.findByIdForUpdate(chatId = ChatId(chat.id))
                    locked.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    messageSendService.process(command(member, request, "before removal commits", chat = chat.id))
                }
            }
            val observing = object : ChatRepository by chatRepository {
                override fun findByIdForUpdate(chatId: ChatId): Chat? {
                    removalStarted.countDown()
                    return chatRepository.findByIdForUpdate(chatId = chatId)
                }
            }
            val removing = ChatMembershipService(repository = observing, tx = tx, outboxRepository = outboxRepository, mapper = mapper)
            try {
                assertTrue(locked.await(10, TimeUnit.SECONDS))
                val removal = concurrently { removing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }
                assertTrue(removalStarted.await(10, TimeUnit.SECONDS))
                release.countDown()
                assertEquals(CommandResult.SAVED, sending.get(10, TimeUnit.SECONDS))
                removal.get(10, TimeUnit.SECONDS)
            } finally {
                release.countDown()
            }

            assertEquals(1L, chatRepository.findById(ChatId(chat.id))!!.lastSequence)
            assertEquals(
                listOf("message_saved", "member_removed"),
                db.queryForList(
                    "SELECT payload->>'type' FROM messenger_outbox_events WHERE room=? ORDER BY publication_order",
                    String::class.java,
                    "group:${chat.id}",
                ),
            )
        }

        @Test
        fun `capacity locks allow concurrent session foreign key checks`() {
            val member = user("capacity-lock-session-member")
            tx.executeWithoutResult {
                assertEquals(setOf(UserId(member)), chatRepository.lockUsers(userIds = listOf(UserId(member))))
                val inserted = concurrently {
                    db.update(
                        "INSERT INTO sessions(token_hash,user_id,device_id,expires_at) VALUES (?,?,'capacity-lock-device',now()+interval '1 hour')",
                        newId().padEnd(64, '0'),
                        member,
                    )
                }.get(10, TimeUnit.SECONDS)
                assertEquals(1, inserted)
            }
        }

        @Test
        fun `concurrent group creation cannot exceed a users group capacity`() {
            val owner = user("group-capacity-owner")
            val member = user("group-capacity-member")
            val seeded = (1..199).map { newId() }
            db.batchUpdate(
                "INSERT INTO chats(id,kind,name,owner_id,member_count) VALUES (?,'GROUP','Capacity seed',?,2)",
                seeded.map { arrayOf<Any>(it, owner) },
            )
            db.batchUpdate(
                "INSERT INTO chat_members(chat_id,user_id) VALUES (?,?),(?,?)",
                seeded.map { arrayOf<Any>(it, owner, it, member) },
            )
            val ready = CountDownLatch(2)
            val attempts = (1..2).map { index ->
                concurrently {
                    ready.countDown()
                    check(ready.await(10, TimeUnit.SECONDS))
                    runCatching { chatService.createGroup(UserId(owner), CreateGroupChatRequest("Capacity $index", listOf(member))) }
                }
            }.map { it.get(10, TimeUnit.SECONDS) }

            assertEquals(1, attempts.count { it.isSuccess })
            assertEquals(1, attempts.count { it.exceptionOrNull() is ApiException })
            assertEquals(
                mapOf(UserId(owner) to 200, UserId(member) to 200),
                chatRepository.groupCountsByUser(userIds = listOf(UserId(owner), UserId(member))),
            )
        }

        @Test
        fun `batch group membership returns only groups joined by user`() {
            val owner = user("batch-group-owner")
            val member = user("batch-group-member")
            val other = user("batch-group-other")
            val included = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Included", listOf(member)))
            val excluded = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Excluded", listOf(other)))
            assertEquals(
                setOf(ChatId(included.id)),
                chatRepository.groupMemberships(listOf(included.id, excluded.id).map(::ChatId), UserId(member)),
            )
        }

        @Test
        fun `group creation notifies every member`() {
            val owner = user("group-owner")
            val member = user("group-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Group", listOf(member)))
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'chatId'=?",
                    Int::class.java,
                    "user:$member",
                    chat.id,
                ),
            )
        }

        @Test
        fun `removing a group member updates the count and writes a personal-room event`() {
            val owner = user("remove-owner")
            val member = user("remove-member")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Group", listOf(member)))
            assertEquals(2, chat.memberCount)

            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))

            assertEquals(1, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'type'='member_removed' AND payload->>'chatId'=?",
                    Int::class.java,
                    "user:$member",
                    chat.id,
                ),
            )
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'type'='member_removed' " +
                        "AND payload->>'memberId'=?",
                    Int::class.java,
                    "group:${chat.id}",
                    member,
                ),
            )
        }

        @Test
        fun `adding group members updates the count without duplicate notifications`() {
            val owner = user("add-owner")
            val first = user("add-first")
            val second = user("add-second")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Group", listOf(first)))

            chatService.addMembers(ChatId(chat.id), UserId(owner), AddGroupMembersRequest(listOf(first, second)))
            chatService.addMembers(ChatId(chat.id), UserId(owner), AddGroupMembersRequest(listOf(second)))

            assertEquals(3, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(3, chatService.get(ChatId(chat.id), UserId(second)).memberCount)
            assertEquals(0L, chatRepository.findById(ChatId(chat.id))!!.lastSequence)
            val payload = db.queryForObject(
                "SELECT payload::text FROM messenger_outbox_events WHERE room=? AND payload->>'type'='membership_changed'",
                String::class.java,
                "group:${chat.id}",
            )!!
            val notification = mapper.readTree(payload)
            assertEquals(
                setOf("type", "version", "eventId", "room", "chatId"),
                notification.properties().map { it.key }.toSet(),
            )
            assertEquals(1, notification.get("version").intValue())
            assertEquals(chat.id, notification.get("chatId").stringValue())
            assertEquals("group:${chat.id}", notification.get("room").stringValue())
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='membership_changed' AND payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE room=? AND payload->>'type'='chat_created' AND payload->>'chatId'=?",
                    Int::class.java,
                    "user:$second",
                    chat.id,
                ),
            )
        }

        @Test
        fun `failed add notifications roll back membership visibility and count`() {
            val owner = user("add-rollback-owner")
            val first = user("add-rollback-first")
            val addition = user("add-rollback-new")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Rollback add", listOf(first)))
            val failingOutbox = object : OutboxRepository by outboxRepository {
                override fun enqueue(messages: Collection<OutboxMessage>) {
                    outboxRepository.enqueue(messages.map { it.copy(id = messages.first().id) })
                }
            }
            val failing = ChatService(repository = chatRepository, outboxRepository = failingOutbox, mapper = mapper, tx = tx)

            assertThrows(RuntimeException::class.java) {
                failing.addMembers(ChatId(chat.id), UserId(owner), AddGroupMembersRequest(listOf(addition)))
            }

            assertEquals(2, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertThrows(ApiException::class.java) { chatService.get(ChatId(chat.id), UserId(addition)) }
            assertEquals(
                2,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'chatId'=?",
                    Int::class.java,
                    chat.id,
                ),
            )
        }

        @Test
        fun `adding members checks ownership before revealing whether users exist`() {
            val owner = user("privacy-owner")
            val member = user("privacy-member")
            val outsider = user("privacy-outsider")
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Group", listOf(member)))

            val denied = assertThrows(ApiException::class.java) {
                chatService.addMembers(ChatId(chat.id), UserId(outsider), AddGroupMembersRequest(listOf(newId())))
            }

            assertEquals(HttpStatus.FORBIDDEN, denied.status)
        }

        @Test
        fun `large group list returns an exact count and a bounded member preview`() {
            val owner = user("preview-owner")
            val members = (1..60).map { user("preview-member-$it") }
            val chat = chatService.createGroup(UserId(owner), CreateGroupChatRequest("Group", members))

            val listed = chatService.list(UserId(owner), null, 50).chats.first { it.id == chat.id }
            val opened = chatService.get(ChatId(chat.id), UserId(owner))

            assertEquals(61, listed.memberCount)
            assertEquals(0, listed.members.size)
            assertEquals(50, opened.members.size)
            assertEquals((members + owner).sorted().take(50), opened.members.map { it.id })
            assertEquals(61, opened.memberCount)
        }

        @Test
        fun `chat list cursor visits each chat once when join times tie`() {
            val owner = user("page-owner")
            val member = user("page-member")
            val ids = (1..3).map { chatService.createGroup(UserId(owner), CreateGroupChatRequest("Page $it", listOf(member))).id }
            db.update("UPDATE chat_members SET joined_at='2026-09-26 10:00:00+00' WHERE user_id=?", owner)

            val first = chatService.list(UserId(owner), null, 2)
            val second = chatService.list(UserId(owner), first.nextCursor, 2)

            assertEquals(ids.toSet(), (first.chats + second.chats).map { it.id }.toSet())
            assertEquals(2, first.chats.size)
            assertEquals(1, second.chats.size)
            assertEquals(null, second.nextCursor)
        }
    }
