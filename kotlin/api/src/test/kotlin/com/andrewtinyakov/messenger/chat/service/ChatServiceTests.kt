package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.chat.messaging.ChatOutbox
import com.andrewtinyakov.messenger.chat.model.Chat
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.model.MemberChatDetails
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.chat.repository.directory.ChatDirectoryRepository
import com.andrewtinyakov.messenger.chat.repository.membership.GroupMembershipRepository
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_PROGRESS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.HIDDEN_MESSAGE_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.SESSIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.ChatKind
import com.andrewtinyakov.messenger.infrastructure.database.postgresFunction
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.message.model.CommandResult
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.service.MessageSendService
import com.andrewtinyakov.messenger.message.service.MessageSendStatusService
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType
import org.jooq.types.DayToSecond
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Duration
import java.time.OffsetDateTime
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class ChatServiceTests
    @Autowired
    constructor(
        private val chatService: ChatService,
        private val chatRepository: ChatRepository,
        private val userRepository: UserRepository,
        private val chatDirectoryRepository: ChatDirectoryRepository,
        private val groupMembershipRepository: GroupMembershipRepository,
        private val chatMembershipService: ChatMembershipService,
        private val outboxRepository: OutboxRepository,
        private val mapper: ObjectMapper,
        private val tx: TransactionTemplate,
        private val messageSendService: MessageSendService,
        private val messageSendStatusService: MessageSendStatusService,
    ) : MessengerIntegrationTest() {
        private val eventChatId = DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId")
        private val eventType = DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type")

        @Test
        fun `activity uses acceptance time rather than an earlier transaction start`() {
            val owner = user("activity-clock-owner")
            val peer = user("activity-clock-peer")
            val chat = chatService.createGroup(UserId(owner), "Clock", listOf(peer).map(::UserId))
            tx.executeWithoutResult {
                val began = db.fetchValue(postgresFunction("transaction_timestamp", SQLDataType.OFFSETDATETIME))!!
                db.fetchValue(postgresFunction("pg_sleep", SQLDataType.OTHER, DSL.inline(0.03)))
                chatRepository.allocateSequencesForMembers(ChatId(chat.id), listOf(UserId(owner)))
                val activity = activityAt(chat.id)!!
                assertTrue(activity.isAfter(began))
            }
        }

        @Test
        fun `a fully hidden candidate window does not scan backwards to an older visible message`() {
            val owner = user("window-owner")
            val peer = user("window-peer")
            val chat = chatService.createGroup(UserId(owner), "Hidden window", listOf(peer).map(::UserId))
            insertMessages(chat.id, peer, 1, 300)
            db.update(CHATS).set(CHATS.NEXT_SEQUENCE, 301L).where(CHATS.ID.eq(chat.id)).execute()
            hideMessages(chat.id, owner, 1L, 300L)
            val result = chatService.get(ChatId(chat.id), UserId(owner))
            assertEquals(null, result.lastMessage)
            assertEquals(0, result.unreadCount)
            assertEquals(true, result.unreadCountCapped)
            assertEquals(1, db.fetchCount(MESSAGES, MESSAGES.CHAT_ID.eq(chat.id), MESSAGES.SEQUENCE.eq(1L)))
        }

        @Test
        fun `chat pages order by activity with deterministic ties and sends update activity transactionally`() {
            val owner = user("activity-owner")
            val peer = user("activity-peer")
            val chats = (1..3).map { chatService.createGroup(UserId(owner), "Activity $it", listOf(peer).map(::UserId)) }
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.JOINED_AT, OffsetDateTime.parse("2026-01-01T00:00:00Z"))
                .where(CHAT_MEMBERS.USER_ID.eq(owner)).execute()
            db.update(CHATS).set(CHATS.LAST_ACTIVITY_AT, OffsetDateTime.parse("2026-02-01T00:00:00Z"))
                .where(CHATS.ID.`in`(chats[0].id, chats[1].id)).execute()
            val first = chatService.list(UserId(owner), null, 1)
            val second = chatService.list(UserId(owner), first.nextCursor, 1)
            val third = chatService.list(UserId(owner), second.nextCursor, 1)
            assertEquals(listOf(chats[1].id, chats[0].id, chats[2].id), (first.chats + second.chats + third.chats).map { it.id })
            assertEquals(null, third.nextCursor)
            messageSendService.process(command(peer, newId(), "Latest", chat = chats[2].id))
            assertEquals(chats[2].id, chatService.list(UserId(owner), null, 1).chats.single().id)
            assertTrue(chatService.get(ChatId(chats[2].id), UserId(owner)).activityAt != null)
            val before = activityAt(chats[0].id)
            tx.executeWithoutResult { status ->
                chatRepository.allocateSequencesForMembers(ChatId(chats[0].id), listOf(UserId(owner)))
                status.setRollbackOnly()
            }
            assertEquals(
                before,
                activityAt(chats[0].id),
            )
        }

        @Test
        fun `unread windows cap raw candidates before own and personal visibility filters`() {
            val owner = user("unread-owner")
            val peer = user("unread-peer")
            val chat = chatService.createGroup(UserId(owner), "Unread", listOf(peer).map(::UserId))

            fun insert(after: Int, through: Int, sender: String) {
                insertMessages(chat.id, sender, after, through)
                db.update(CHATS).set(CHATS.NEXT_SEQUENCE, through + 1L).where(CHATS.ID.eq(chat.id)).execute()
            }

            fun read() = chatService.get(ChatId(chat.id), UserId(owner))
            insert(1, 255, peer)
            assertEquals(255, read().unreadCount)
            assertEquals(false, read().unreadCountCapped)
            insert(256, 256, peer)
            assertEquals(256, read().unreadCount)
            assertEquals(true, read().unreadCountCapped)
            insert(257, 257, owner)
            assertEquals(255, read().unreadCount)
            assertEquals(true, read().unreadCountCapped)
            db.deleteFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.id), MESSAGES.SEQUENCE.eq(250L)).execute()
            assertEquals(255, read().unreadCount)
            hideMessages(chat.id, owner, 100L, 257L)
            assertEquals(100, read().unreadCount)
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE, 100L)
                .where(CHAT_MEMBERS.CHAT_ID.eq(chat.id), CHAT_MEMBERS.USER_ID.eq(owner)).execute()
            assertEquals(0, read().unreadCount)
            assertEquals(null, read().lastMessage)
            db.insertInto(CHAT_READ_PROGRESS)
                .set(CHAT_READ_PROGRESS.CHAT_ID, chat.id)
                .set(CHAT_READ_PROGRESS.USER_ID, owner)
                .set(CHAT_READ_PROGRESS.THROUGH_SEQUENCE, 257L)
                .set(CHAT_READ_PROGRESS.READ_AT, DSL.currentOffsetDateTime())
                .onConflict(CHAT_READ_PROGRESS.CHAT_ID, CHAT_READ_PROGRESS.USER_ID).doUpdate()
                .set(CHAT_READ_PROGRESS.THROUGH_SEQUENCE, 257L)
                .set(CHAT_READ_PROGRESS.READ_AT, DSL.currentOffsetDateTime()).execute()
            assertEquals(false, read().unreadCountCapped)
            val listed = chatService.list(UserId(owner), null, 100).chats.single { it.id == chat.id }
            assertEquals(read().unreadCount, listed.unreadCount)
        }

        @Test
        fun `chat summaries include sender names and obey viewer visibility across sequence gaps`() {
            val owner = user("summary-owner")
            val member = user("summary-member")
            val chat = chatService.createGroup(UserId(owner), "Summary", listOf(member).map(::UserId))
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
            hideMessages(chat.id, owner, 1L, 2L)
            assertEquals("1", chatService.get(ChatId(chat.id), UserId(owner)).lastMessage!!.sequence)
            assertEquals("2", chatService.get(ChatId(chat.id), UserId(member)).lastMessage!!.sequence)
            db.deleteFrom(MESSAGES).where(MESSAGES.CHAT_ID.eq(chat.id), MESSAGES.SEQUENCE.eq(1L)).execute()
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.CLEARED_THROUGH_SEQUENCE, 2L)
                .where(CHAT_MEMBERS.CHAT_ID.eq(chat.id), CHAT_MEMBERS.USER_ID.eq(member)).execute()
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(member)).lastMessage)
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.HIDDEN_THROUGH_SEQUENCE, 2L)
                .where(CHAT_MEMBERS.CHAT_ID.eq(chat.id), CHAT_MEMBERS.USER_ID.eq(owner)).execute()
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            messageSendService.process(command(member, newId(), "Visible again", chat = chat.id))
            assertEquals("3", chatService.get(ChatId(chat.id), UserId(owner)).lastMessage!!.sequence)
            db.update(CHATS).set(CHATS.CLEARED_THROUGH_SEQUENCE, 3L).where(CHATS.ID.eq(chat.id)).execute()
            assertEquals(null, chatService.get(ChatId(chat.id), UserId(owner)).lastMessage)
            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))
            assertThrows(ApiException::class.java) { chatService.get(ChatId(chat.id), UserId(member)) }
        }

        @Test
        fun `chat reads retain one authorized snapshot during member removal`() {
            val owner = user("snapshot-chat-owner")
            val member = user("snapshot-chat-member")
            val chat = chatService.createGroup(UserId(owner), "Snapshot", listOf(member).map(::UserId))
            val removingRepository = object : ChatDirectoryRepository by chatDirectoryRepository {
                override fun findMemberDetails(chatId: ChatId, userId: UserId): MemberChatDetails? {
                    val snapshot = chatDirectoryRepository.findMemberDetails(chatId = chatId, userId = userId)
                    concurrently { chatMembershipService.removeMember(chatId, UserId(owner), UserId(member)) }.join()
                    return snapshot
                }
            }
            val concurrentReads = ChatService(
                chatRepository = chatRepository,
                chatDirectoryRepository = removingRepository,
                groupMembershipRepository = groupMembershipRepository,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(outboxRepository, mapper),
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
            val failing = ChatService(
                chatRepository = invalidEvents,
                chatDirectoryRepository = chatDirectoryRepository,
                groupMembershipRepository = groupMembershipRepository,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(outboxRepository, mapper),
                tx = tx,
            )

            assertThrows(RuntimeException::class.java) {
                failing.createGroup(UserId(owner), "Rollback", listOf(member).map(::UserId))
            }

            val chatId = requireNotNull(attempted)
            assertEquals(null, chatDirectoryRepository.findById(chatId))
            assertEquals(emptyList<Any>(), chatRepository.findMemberIds(chatId))
            assertEquals(
                0,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventChatId.eq(chatId.value)),
            )
        }

        @Test
        fun `multiple initial and added member chunks keep exact stored counts`() {
            val owner = user("chunk-owner")
            val members = (1..501).map { user("chunk-initial-$it") }
            val additions = (1..501).map { user("chunk-addition-$it") }

            val chat = chatService.createGroup(UserId(owner), "Chunks", members.map(::UserId))
            assertEquals(502, chat.memberCount)
            assertEquals(50, chat.members.size)
            assertEquals((members + owner).sorted().take(50), chat.members.map { it.id })

            chatService.addMembers(ChatId(chat.id), UserId(owner), additions.map(::UserId))

            assertEquals(1003, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(1003, chatRepository.findMemberIds(ChatId(chat.id)).size)
            assertEquals(
                1003,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventType.eq("chat_created"), eventChatId.eq(chat.id)),
            )
        }

        @Test
        fun `missing and repeated removal do not change counters or publish events`() {
            val owner = user("noop-remove-owner")
            val member = user("noop-remove-member")
            val chat = chatService.createGroup(UserId(owner), "Removal", listOf(member).map(::UserId))
            val chatId = ChatId(chat.id)

            assertThrows(ApiException::class.java) { chatMembershipService.removeMember(chatId, UserId(owner), UserId(newId())) }
            assertEquals(2, chatService.get(chatId, UserId(owner)).memberCount)
            chatMembershipService.removeMember(chatId, UserId(owner), UserId(member))
            assertThrows(ApiException::class.java) { chatMembershipService.removeMember(chatId, UserId(owner), UserId(member)) }

            assertEquals(1, chatService.get(chatId, UserId(owner)).memberCount)
            assertEquals(
                2,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventType.eq("member_removed"), eventChatId.eq(chat.id)),
            )
        }

        @Test
        fun `failed removal events roll back membership and its counter`() {
            val owner = user("remove-rollback-owner")
            val member = user("remove-rollback-member")
            val chat = chatService.createGroup(UserId(owner), "Rollback removal", listOf(member).map(::UserId))
            val failingOutbox = object : OutboxRepository by outboxRepository {
                override fun enqueue(messages: Collection<OutboxMessage>) {
                    outboxRepository.enqueue(messages.map { it.copy(id = messages.first().id) })
                }
            }
            val failing = ChatMembershipService(
                chatRepository = chatRepository,
                groupMembershipRepository = groupMembershipRepository,
                tx = tx,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(failingOutbox, mapper),
            )

            assertThrows(RuntimeException::class.java) { failing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }

            assertEquals(2, chatService.get(ChatId(chat.id), UserId(member)).memberCount)
            assertEquals(
                0,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventType.eq("member_removed"), eventChatId.eq(chat.id)),
            )
        }

        @Test
        fun `concurrent add and removal preserve the exact membership count`() {
            val owner = user("concurrent-add-owner")
            val member = user("concurrent-add-member")
            val addition = user("concurrent-add-new")
            val chat = chatService.createGroup(UserId(owner), "Concurrent", listOf(member).map(::UserId))
            val removed = CountDownLatch(1)
            val release = CountDownLatch(1)
            val pausedRepository = object : GroupMembershipRepository by groupMembershipRepository {
                override fun deleteMemberAndDecrementCount(chatId: ChatId, userId: UserId): Boolean {
                    val result = groupMembershipRepository.deleteMemberAndDecrementCount(chatId = chatId, userId = userId)
                    removed.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    return result
                }
            }
            val removing =
                ChatMembershipService(
                    chatRepository = chatRepository,
                    groupMembershipRepository = pausedRepository,
                    tx = tx,
                    userRepository = userRepository,
                    chatOutbox = ChatOutbox(outboxRepository, mapper),
                )
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
                    ChatService(
                        chatRepository = addingRepository,
                        chatDirectoryRepository = chatDirectoryRepository,
                        groupMembershipRepository = groupMembershipRepository,
                        userRepository = userRepository,
                        chatOutbox = ChatOutbox(outboxRepository, mapper),
                        tx = tx,
                    )
                val adding = concurrently {
                    addingService.addMembers(ChatId(chat.id), UserId(owner), listOf(addition).map(::UserId))
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
            val chat = chatService.createGroup(UserId(owner), "Concurrent removal", listOf(member).map(::UserId))
            val removing = ChatMembershipService(
                chatRepository = chatRepository,
                groupMembershipRepository = groupMembershipRepository,
                tx = tx,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(outboxRepository, mapper),
            )
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
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventType.eq("member_removed"), eventChatId.eq(chat.id)),
            )
        }

        @Test
        fun `send waiting behind removal rejects without allocating a sequence`() {
            val owner = user("remove-before-send-owner")
            val member = user("remove-before-send-member")
            val chat = chatService.createGroup(UserId(owner), "Remove before send", listOf(member).map(::UserId))
            val request = newId()
            val deleted = CountDownLatch(1)
            val release = CountDownLatch(1)
            val removalBackend = CompletableFuture<Int>()
            val paused = object : GroupMembershipRepository by groupMembershipRepository {
                override fun deleteMemberAndDecrementCount(chatId: ChatId, userId: UserId): Boolean {
                    val result = groupMembershipRepository.deleteMemberAndDecrementCount(chatId = chatId, userId = userId)
                    removalBackend.complete(db.fetchValue(postgresFunction("pg_backend_pid", SQLDataType.INTEGER))!!)
                    deleted.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    return result
                }
            }
            val removing = ChatMembershipService(
                chatRepository = chatRepository,
                groupMembershipRepository = paused,
                tx = tx,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(outboxRepository, mapper),
            )
            val removal = concurrently { removing.removeMember(ChatId(chat.id), UserId(owner), UserId(member)) }
            try {
                assertTrue(deleted.await(10, TimeUnit.SECONDS))
                val send = concurrently {
                    messageSendService.process(command(member, request, "racing removal", chat = chat.id))
                }
                val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(10)
                val statActivity = DSL.table(DSL.name("pg_catalog", "pg_stat_activity"))
                val pid = DSL.field(DSL.name("pid"), SQLDataType.INTEGER)
                val blockers = postgresFunction("pg_blocking_pids", SQLDataType.INTEGER.arrayDataType, pid)
                val removalPid = DSL.inline(removalBackend.get(10, TimeUnit.SECONDS))
                while (!db.fetchExists(statActivity, removalPid.eq(DSL.any(blockers)))) {
                    check(System.nanoTime() < deadline) { "Send did not wait for the removal transaction" }
                    Thread.sleep(10)
                }
                release.countDown()
                assertEquals(CommandResult.REJECTED, send.get(10, TimeUnit.SECONDS))
                removal.get(10, TimeUnit.SECONDS)
            } finally {
                release.countDown()
            }

            assertEquals(SendRejectionReason.NOT_A_MEMBER, messageSendStatusService.status(UserId(member), RequestId(request)).reason)
            assertEquals(1L, chatDirectoryRepository.findById(ChatId(chat.id))!!.lastSequence, "only the removal took a number")
        }

        @Test
        fun `send holding chat lock commits its message event before removal`() {
            val owner = user("send-before-remove-owner")
            val member = user("send-before-remove-member")
            val chat = chatService.createGroup(UserId(owner), "Send before remove", listOf(member).map(::UserId))
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
            val removing = ChatMembershipService(
                chatRepository = observing,
                groupMembershipRepository = groupMembershipRepository,
                tx = tx,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(outboxRepository, mapper),
            )
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

            assertEquals(2L, chatDirectoryRepository.findById(ChatId(chat.id))!!.lastSequence)
            assertEquals(
                listOf("message_saved", "member_removed"),
                db.select(eventType).from(MESSENGER_OUTBOX_EVENTS)
                    .where(MESSENGER_OUTBOX_EVENTS.ROOM.eq("group:${chat.id}"))
                    .orderBy(MESSENGER_OUTBOX_EVENTS.PUBLICATION_ORDER).fetch(eventType),
            )
        }

        @Test
        fun `capacity locks allow concurrent session foreign key checks`() {
            val member = user("capacity-lock-session-member")
            tx.executeWithoutResult {
                assertEquals(setOf(UserId(member)), groupMembershipRepository.lockUsers(userIds = listOf(UserId(member))))
                val inserted = concurrently {
                    db.insertInto(SESSIONS)
                        .set(SESSIONS.TOKEN_HASH, newId().padEnd(64, '0'))
                        .set(SESSIONS.USER_ID, member)
                        .set(SESSIONS.DEVICE_ID, "capacity-lock-device")
                        .set(SESSIONS.EXPIRES_AT, DSL.currentOffsetDateTime().add(DSL.inline(DayToSecond.valueOf(Duration.ofHours(1)))))
                        .execute()
                }.get(10, TimeUnit.SECONDS)
                assertEquals(1, inserted)
            }
        }

        @Test
        fun `concurrent group creation cannot exceed a users group capacity`() {
            val owner = user("group-capacity-owner")
            val member = user("group-capacity-member")
            val seeded = (1..199).map { newId() }
            db.batch(
                seeded.map {
                    db.insertInto(CHATS, CHATS.ID, CHATS.KIND, CHATS.NAME, CHATS.OWNER_ID, CHATS.MEMBER_COUNT)
                        .values(it, ChatKind.GROUP, "Capacity seed", owner, 2)
                },
            ).execute()
            db.batch(
                seeded.map {
                    db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID)
                        .values(it, owner).values(it, member)
                },
            ).execute()
            val ready = CountDownLatch(2)
            val attempts = (1..2).map { index ->
                concurrently {
                    ready.countDown()
                    check(ready.await(10, TimeUnit.SECONDS))
                    runCatching { chatService.createGroup(UserId(owner), "Capacity $index", listOf(member).map(::UserId)) }
                }
            }.map { it.get(10, TimeUnit.SECONDS) }

            assertEquals(1, attempts.count { it.isSuccess })
            assertEquals(1, attempts.count { it.exceptionOrNull() is ApiException })
            assertEquals(
                mapOf(UserId(owner) to 200, UserId(member) to 200),
                groupMembershipRepository.groupCountsByUser(userIds = listOf(UserId(owner), UserId(member))),
            )
        }

        @Test
        fun `batch group membership returns only groups joined by user`() {
            val owner = user("batch-group-owner")
            val member = user("batch-group-member")
            val other = user("batch-group-other")
            val included = chatService.createGroup(UserId(owner), "Included", listOf(member).map(::UserId))
            val excluded = chatService.createGroup(UserId(owner), "Excluded", listOf(other).map(::UserId))
            val memberChatIds = chatService.list(UserId(member), cursor = null, limit = 100).chats.map { it.id }
            assertTrue(included.id in memberChatIds)
            assertFalse(excluded.id in memberChatIds)
        }

        @Test
        fun `group creation notifies every member`() {
            val owner = user("group-owner")
            val member = user("group-member")
            val chat = chatService.createGroup(UserId(owner), "Group", listOf(member).map(::UserId))
            assertEquals(
                2,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventType.eq("chat_created"), eventChatId.eq(chat.id)),
            )
            assertEquals(
                1,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    MESSENGER_OUTBOX_EVENTS.ROOM.eq("user:$member"),
                    eventChatId.eq(chat.id),
                ),
            )
        }

        @Test
        fun `removing a group member updates the count and writes a personal-room event`() {
            val owner = user("remove-owner")
            val member = user("remove-member")
            val chat = chatService.createGroup(UserId(owner), "Group", listOf(member).map(::UserId))
            assertEquals(2, chat.memberCount)

            chatMembershipService.removeMember(ChatId(chat.id), UserId(owner), UserId(member))

            assertEquals(1, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(
                1,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    MESSENGER_OUTBOX_EVENTS.ROOM.eq("user:$member"),
                    eventChatId.eq(chat.id),
                    eventType.eq("member_removed"),
                ),
            )
            assertEquals(
                1,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    MESSENGER_OUTBOX_EVENTS.ROOM.eq("group:${chat.id}"),
                    eventType.eq("member_removed"),
                    DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "memberId").eq(member),
                ),
            )
        }

        @Test
        fun `adding group members updates the count without duplicate notifications`() {
            val owner = user("add-owner")
            val first = user("add-first")
            val second = user("add-second")
            val chat = chatService.createGroup(UserId(owner), "Group", listOf(first).map(::UserId))

            chatService.addMembers(ChatId(chat.id), UserId(owner), listOf(first, second).map(::UserId))
            chatService.addMembers(ChatId(chat.id), UserId(owner), listOf(second).map(::UserId))

            assertEquals(3, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertEquals(3, chatService.get(ChatId(chat.id), UserId(second)).memberCount)
            assertEquals(1L, chatDirectoryRepository.findById(ChatId(chat.id))!!.lastSequence)
            val payload = db.fetchValue(
                MESSENGER_OUTBOX_EVENTS.PAYLOAD,
                MESSENGER_OUTBOX_EVENTS.ROOM.eq("group:${chat.id}").and(eventType.eq("membership_changed")),
            )!!.data()
            val notification = mapper.readTree(payload)
            assertEquals(
                setOf("type", "version", "eventId", "room", "chatId", "seq"),
                notification.properties().map { it.key }.toSet(),
            )
            assertEquals("1", notification.get("seq").stringValue())
            assertEquals(1, notification.get("version").intValue())
            assertEquals(chat.id, notification.get("chatId").stringValue())
            assertEquals("group:${chat.id}", notification.get("room").stringValue())
            assertEquals(
                1,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventType.eq("membership_changed"), eventChatId.eq(chat.id)),
            )
            assertEquals(
                1,
                db.fetchCount(
                    MESSENGER_OUTBOX_EVENTS,
                    MESSENGER_OUTBOX_EVENTS.ROOM.eq("user:$second"),
                    eventChatId.eq(chat.id),
                    eventType.eq("chat_created"),
                ),
            )
        }

        @Test
        fun `failed add notifications roll back membership visibility and count`() {
            val owner = user("add-rollback-owner")
            val first = user("add-rollback-first")
            val addition = user("add-rollback-new")
            val chat = chatService.createGroup(UserId(owner), "Rollback add", listOf(first).map(::UserId))
            val failingOutbox = object : OutboxRepository by outboxRepository {
                override fun enqueue(messages: Collection<OutboxMessage>) {
                    outboxRepository.enqueue(messages.map { it.copy(id = messages.first().id) })
                }
            }
            val failing = ChatService(
                chatRepository = chatRepository,
                chatDirectoryRepository = chatDirectoryRepository,
                groupMembershipRepository = groupMembershipRepository,
                userRepository = userRepository,
                chatOutbox = ChatOutbox(failingOutbox, mapper),
                tx = tx,
            )

            assertThrows(RuntimeException::class.java) {
                failing.addMembers(ChatId(chat.id), UserId(owner), listOf(addition).map(::UserId))
            }

            assertEquals(2, chatService.get(ChatId(chat.id), UserId(owner)).memberCount)
            assertThrows(ApiException::class.java) { chatService.get(ChatId(chat.id), UserId(addition)) }
            assertEquals(
                2,
                db.fetchCount(MESSENGER_OUTBOX_EVENTS, eventChatId.eq(chat.id)),
            )
        }

        @Test
        fun `adding members checks ownership before revealing whether users exist`() {
            val owner = user("privacy-owner")
            val member = user("privacy-member")
            val outsider = user("privacy-outsider")
            val chat = chatService.createGroup(UserId(owner), "Group", listOf(member).map(::UserId))

            val denied = assertThrows(ApiException::class.java) {
                chatService.addMembers(ChatId(chat.id), UserId(outsider), listOf(newId()).map(::UserId))
            }

            assertEquals(HttpStatus.FORBIDDEN, denied.status)
        }

        @Test
        fun `large group list returns an exact count and a bounded member preview`() {
            val owner = user("preview-owner")
            val members = (1..60).map { user("preview-member-$it") }
            val chat = chatService.createGroup(UserId(owner), "Group", members.map(::UserId))

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
            val ids = (1..3).map { chatService.createGroup(UserId(owner), "Page $it", listOf(member).map(::UserId)).id }
            db.update(CHAT_MEMBERS).set(CHAT_MEMBERS.JOINED_AT, OffsetDateTime.parse("2026-09-26T10:00:00Z"))
                .where(CHAT_MEMBERS.USER_ID.eq(owner)).execute()

            val first = chatService.list(UserId(owner), null, 2)
            val second = chatService.list(UserId(owner), first.nextCursor, 2)

            assertEquals(ids.toSet(), (first.chats + second.chats).map { it.id }.toSet())
            assertEquals(2, first.chats.size)
            assertEquals(1, second.chats.size)
            assertEquals(null, second.nextCursor)
        }

        private fun activityAt(chatId: String): OffsetDateTime? =
            db.select(CHATS.LAST_ACTIVITY_AT).from(CHATS).where(CHATS.ID.eq(chatId)).fetchSingle().value1()

        private fun insertMessages(chatId: String, sender: String, from: Int, through: Int) {
            val series = DSL.generateSeries(from, through).`as`("series", "sequence")
            val sequence = series.field(0, SQLDataType.BIGINT)!!
            db.insertInto(
                MESSAGES,
                MESSAGES.ID,
                MESSAGES.CHAT_ID,
                MESSAGES.SEQUENCE,
                MESSAGES.SENDER_ID,
                MESSAGES.BODY,
                MESSAGES.CREATED_AT,
            )
                .select(
                    db.select(
                        DSL.concat(DSL.inline(chatId.take(20)), DSL.lpad(sequence.cast(SQLDataType.VARCHAR), 6, "0")),
                        DSL.inline(chatId),
                        sequence,
                        DSL.inline(sender),
                        DSL.inline("body"),
                        DSL.currentOffsetDateTime(),
                    ).from(series),
                ).execute()
        }

        private fun hideMessages(chatId: String, user: String, after: Long, through: Long) {
            db.insertInto(
                HIDDEN_MESSAGE_RANGES,
                HIDDEN_MESSAGE_RANGES.CHAT_ID,
                HIDDEN_MESSAGE_RANGES.USER_ID,
                HIDDEN_MESSAGE_RANGES.AFTER_SEQUENCE,
                HIDDEN_MESSAGE_RANGES.THROUGH_SEQUENCE,
            ).values(chatId, user, after, through).execute()
        }
    }
