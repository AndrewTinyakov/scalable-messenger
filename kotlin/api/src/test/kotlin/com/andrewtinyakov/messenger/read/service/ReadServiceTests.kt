package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.JooqChatRepository
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHATS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_MEMBERS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_NOTIFICATIONS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_PROGRESS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.CHAT_READ_RANGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSAGES
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.PENDING_READ_NOTIFICATIONS
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.message.model.MessageId
import com.andrewtinyakov.messenger.read.config.ReadProperties
import com.andrewtinyakov.messenger.read.messaging.ReadOutbox
import com.andrewtinyakov.messenger.read.monitoring.ReadMetrics
import com.andrewtinyakov.messenger.read.repository.JooqReadRepository
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.jooq.impl.DSL
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertNull
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.http.HttpStatus
import org.springframework.transaction.support.TransactionTemplate
import tools.jackson.databind.ObjectMapper
import java.time.Clock
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class ReadServiceTests
    @Autowired
    constructor(
        private val chatService: ChatService,
        private val outbox: OutboxRepository,
        private val mapper: ObjectMapper,
        private val tx: TransactionTemplate,
    ) : MessengerIntegrationTest() {
        private fun fixture(count: Int = 3, messages: Int = 3, createdAt: String = "2026-11-01T12:00:00Z"): ReadFixture {
            val owner = UserId(user("reads-${newId()}"))
            val members = (1..count).map { UserId(user("reader-${newId()}")) }
            val chat = ChatId(chatService.createGroup(owner, "Read receipts", members).id)
            val timestamp = OffsetDateTime.parse(createdAt)
            val ids = (1..messages).map { sequence ->
                MessageId(newId()).also { id ->
                    db.insertInto(MESSAGES)
                        .set(MESSAGES.ID, id.value)
                        .set(MESSAGES.CHAT_ID, chat.value)
                        .set(MESSAGES.SEQUENCE, sequence.toLong())
                        .set(MESSAGES.SENDER_ID, owner.value)
                        .set(MESSAGES.BODY, "hello")
                        .set(MESSAGES.CREATED_AT, timestamp)
                        .execute()
                }
            }
            db.update(CHATS).set(CHATS.NEXT_SEQUENCE, messages.toLong() + 1).where(CHATS.ID.eq(chat.value)).execute()
            return ReadFixture(owner, members, chat, ids)
        }

        private fun service(clock: Clock, registry: SimpleMeterRegistry = SimpleMeterRegistry()): ReadService = ReadService(
            JooqReadRepository(db, clock),
            JooqChatRepository(db),
            ReadOutbox(outbox, mapper),
            ReadProperties(),
            tx,
            clock,
            ReadMetrics(registry),
        )

        @Test
        fun `pending advance locks out drain until progress commits`() {
            val f = fixture(messages = 2)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val repository = JooqReadRepository(db, clock)
            tx.execute { repository.advance(f.chat, f.members.first(), 1) }
            val advanced = CountDownLatch(1)
            val release = CountDownLatch(1)
            val future = concurrently {
                tx.execute {
                    repository.advance(f.chat, f.members.first(), 2)
                    advanced.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                }
            }
            try {
                assertTrue(advanced.await(10, TimeUnit.SECONDS))
                assertTrue(tx.execute { repository.pendingNotifications(OffsetDateTime.now(clock), 1000) }!!.keys.none { it == f.chat })
                assertEquals("1", service(clock).summary(f.chat, f.owner).maxOtherReadSequence)
            } finally {
                release.countDown()
                future.get(10, TimeUnit.SECONDS)
            }
            assertTrue(tx.execute { repository.pendingNotifications(OffsetDateTime.now(clock), 1000) }!!.containsKey(f.chat))
            assertEquals("2", service(clock).summary(f.chat, f.owner).maxOtherReadSequence)
        }

        @Test
        fun `deleted chats discard pending read work`() {
            val f = fixture(messages = 1)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val repository = JooqReadRepository(db, clock)
            tx.execute { repository.advance(f.chat, f.members.first(), 1) }
            db.update(CHATS).set(CHATS.DELETED_AT, DSL.currentOffsetDateTime()).where(CHATS.ID.eq(f.chat.value)).execute()
            tx.execute { repository.pendingNotifications(OffsetDateTime.now(clock), 1000) }
            assertEquals(
                0,
                db.fetchCount(PENDING_READ_NOTIFICATIONS, PENDING_READ_NOTIFICATIONS.CHAT_ID.eq(f.chat.value)),
            )
        }

        @Test
        fun `an immediate notification does not spend the next bucket on unchanged progress`() {
            val f = fixture(messages = 3)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), 1L)
            assertEquals(1, sharedNotifications(f.chat))
            clock.set("2026-11-02T12:00:02Z")
            reads.publishPendingNotifications()
            assertEquals(1, sharedNotifications(f.chat))
            clock.set("2026-11-02T12:00:02.100Z")
            reads.advance(f.chat, f.members.first(), 3L)
            assertEquals(2, sharedNotifications(f.chat))
            assertEquals("3", reads.summary(f.chat, f.owner).maxOtherReadSequence)
        }

        @Test
        fun `last read in an already notified bucket gets a durable trailing notification`() {
            val f = fixture(messages = 3)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), 1L)
            db.deleteFrom(MESSENGER_OUTBOX_EVENTS).where(MESSENGER_OUTBOX_EVENTS.ROOM.eq("group:${f.chat.value}")).execute()
            clock.set("2026-11-02T12:00:01Z")
            reads.advance(f.chat, f.members.first(), 3L)
            reads.publishPendingNotifications()
            assertEquals(0, sharedNotifications(f.chat))
            clock.set("2026-11-02T12:00:02Z")
            reads.publishPendingNotifications()
            assertEquals(1, sharedNotifications(f.chat))
            assertEquals("3", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            reads.publishPendingNotifications()
            assertEquals(1, sharedNotifications(f.chat))
            assertEquals(
                0,
                db.fetchCount(PENDING_READ_NOTIFICATIONS, PENDING_READ_NOTIFICATIONS.CHAT_ID.eq(f.chat.value)),
            )
        }

        @Test
        fun `committed reader retains notification work when the bucket winner rolls back`() {
            val f = fixture(messages = 2)
            val reads = service(MutableClock("2026-11-02T12:00:00Z"))
            val claimed = CountDownLatch(1)
            val release = CountDownLatch(1)
            val winner = concurrently {
                tx.execute { status ->
                    reads.advance(f.chat, f.members[0], 1L)
                    claimed.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    status.setRollbackOnly()
                }
            }
            try {
                assertTrue(claimed.await(10, TimeUnit.SECONDS))
                assertEquals("2", reads.advance(f.chat, f.members[1], 2L).throughSequence)
            } finally {
                release.countDown()
                winner.get(10, TimeUnit.SECONDS)
            }
            reads.publishPendingNotifications()
            assertEquals(1, sharedNotifications(f.chat))
            assertEquals("2", reads.summary(f.chat, f.owner).maxOtherReadSequence)
        }

        private fun sharedNotifications(chatId: ChatId): Int = db.fetchCount(
            MESSENGER_OUTBOX_EVENTS,
            MESSENGER_OUTBOX_EVENTS.ROOM.eq("group:${chatId.value}"),
            DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("reads_changed"),
        )

        private fun groupNotificationsForChat(chatId: ChatId): Int = db.fetchCount(
            MESSENGER_OUTBOX_EVENTS,
            DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("reads_changed"),
            DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId").eq(chatId.value),
            MESSENGER_OUTBOX_EVENTS.ROOM.like("group:%"),
        )

        @Test
        fun `every advanced read invalidates its account even when group notifications coalesce`() {
            val f = fixture(messages = 2)
            val registry = SimpleMeterRegistry()
            val reads = service(MutableClock("2026-11-02T12:00:00Z"), registry)
            assertEquals(2, chatService.get(f.chat, f.members[0]).unreadCount)
            reads.advance(f.chat, f.members[0], 2L)
            reads.advance(f.chat, f.members[1], 2L)
            reads.advance(f.chat, f.members[1], 2L)
            assertEquals(0, chatService.get(f.chat, f.members[0]).unreadCount)
            assertEquals(2.0, registry.get("messenger.read.advances").tag("outcome", "advanced").counter().count())
            assertEquals(1.0, registry.get("messenger.read.advances").tag("outcome", "unchanged").counter().count())
            assertEquals(1.0, registry.get("messenger.read.notifications").tag("outcome", "emitted").counter().count())
            assertEquals(1.0, registry.get("messenger.read.notifications").tag("outcome", "coalesced").counter().count())
            for (member in f.members.take(2)) {
                assertEquals(
                    1,
                    db.fetchCount(
                        MESSENGER_OUTBOX_EVENTS,
                        MESSENGER_OUTBOX_EVENTS.ROOM.eq("user:${member.value}"),
                        DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "type").eq("reads_changed"),
                        DSL.jsonbGetAttributeAsText(MESSENGER_OUTBOX_EVENTS.PAYLOAD, "chatId").eq(f.chat.value),
                    ),
                )
            }
        }

        @Test
        fun `creation days follow UTC even when the database session is in the previous day`() {
            val f = fixture(messages = 1, createdAt = "2026-11-02T00:05:00Z")
            val clock = MutableClock("2026-11-02T00:06:00Z")
            val reads = service(clock)
            val reader = f.members.first()
            tx.execute {
                db.setLocal(DSL.name("TimeZone"), DSL.inline("America/Los_Angeles")).execute()
                reads.advance(f.chat, reader, 1L)
                assertEquals(reader.value, reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.single().userId)
            }
        }

        @Test
        fun `first accepted prefix timestamps survive repeats backwards progress and another device`() {
            val f = fixture()
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val member = f.members.first()
            val first = reads.advance(f.chat, member, 2L)
            assertEquals("2", first.throughSequence)
            assertEquals(OffsetDateTime.parse("2026-11-02T12:00:00Z"), first.readAt)
            clock.set("2026-11-02T13:00:00Z")
            assertEquals(first.readAt!!.toInstant(), reads.advance(f.chat, member, 1L).readAt!!.toInstant())
            assertEquals(first.readAt.toInstant(), reads.advance(f.chat, member, 2L).readAt!!.toInstant())
            val latest = reads.advance(f.chat, member, 3L)
            assertEquals(OffsetDateTime.parse("2026-11-02T13:00:00Z"), latest.readAt)
            assertEquals(
                first.readAt.toInstant(),
                reads.readers(f.chat, f.owner, f.messages.first(), null, 50).readers.single().readAt.toInstant(),
            )
            assertEquals(
                latest.readAt!!.toInstant(),
                reads.readers(f.chat, f.owner, f.messages.last(), null, 50).readers.single().readAt.toInstant(),
            )
            assertEquals("3", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertEquals("0", reads.summary(f.chat, member).maxOtherReadSequence)
            assertEquals(2, db.fetchCount(CHAT_READ_RANGES, CHAT_READ_RANGES.CHAT_ID.eq(f.chat.value)))
            clock.set("2026-11-02T11:00:00Z")
            assertEquals(latest.readAt.toInstant(), reads.advance(f.chat, member, 3L).readAt!!.toInstant())
        }

        @Test
        fun `parallel devices converge with nonoverlapping ranges and bounded group fanout`() {
            val f = fixture(count = 12, messages = 30)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val pool = Executors.newFixedThreadPool(8)
            val start = CountDownLatch(1)
            try {
                val tasks = (1..30).map { sequence ->
                    pool.submit(
                        Callable {
                            start.await()
                            reads.advance(f.chat, f.members.first(), sequence.toLong())
                        },
                    )
                }
                start.countDown()
                tasks.forEach { it.get(20, TimeUnit.SECONDS) }
                val others = f.members.drop(1).map { member ->
                    pool.submit(Callable { reads.advance(f.chat, member, 30L) })
                }
                others.forEach { it.get(20, TimeUnit.SECONDS) }
            } finally {
                pool.shutdownNow()
                assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            }
            assertEquals("30", reads.summary(f.chat, f.members.first()).throughSequence)
            val earlier = CHAT_READ_RANGES.`as`("earlier")
            val later = CHAT_READ_RANGES.`as`("later")
            assertEquals(
                0,
                db.fetchCount(
                    earlier.join(later).on(
                        earlier.CHAT_ID.eq(later.CHAT_ID),
                        earlier.USER_ID.eq(later.USER_ID),
                        earlier.CREATION_DAY.eq(later.CREATION_DAY),
                        earlier.THROUGH_SEQUENCE.lt(later.THROUGH_SEQUENCE),
                        earlier.THROUGH_SEQUENCE.gt(later.AFTER_SEQUENCE),
                    ),
                    earlier.CHAT_ID.eq(f.chat.value),
                ),
            )
            assertEquals(
                1,
                groupNotificationsForChat(f.chat),
            )
            assertEquals(
                1,
                db.fetchCount(CHAT_READ_NOTIFICATIONS, CHAT_READ_NOTIFICATIONS.CHAT_ID.eq(f.chat.value)),
            )
        }

        @Test
        fun `independent readers commit while a coalesced notification is still uncommitted`() {
            val f = fixture(messages = 2)
            val reads = service(MutableClock("2026-11-02T12:00:00Z"))
            val claimed = CountDownLatch(1)
            val release = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            val winner = pool.submit(
                Callable {
                    tx.execute {
                        val progress = reads.advance(f.chat, f.members[0], 1L)
                        claimed.countDown()
                        check(release.await(10, TimeUnit.SECONDS))
                        progress
                    }
                },
            )
            try {
                assertTrue(claimed.await(10, TimeUnit.SECONDS))
                val other = pool.submit(Callable { reads.advance(f.chat, f.members[1], 2L) })
                assertEquals("2", other.get(2, TimeUnit.SECONDS).throughSequence)
                assertEquals("2", reads.summary(f.chat, f.owner).maxOtherReadSequence)
                assertEquals(
                    0,
                    groupNotificationsForChat(f.chat),
                )
            } finally {
                release.countDown()
                winner.get(10, TimeUnit.SECONDS)
                pool.shutdownNow()
                assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            }
            assertEquals(
                1,
                groupNotificationsForChat(f.chat),
            )
        }

        @Test
        fun `reader details paginate current members and expire exactly seven days after creation`() {
            val f = fixture(messages = 1, createdAt = "2026-11-01T12:00:00Z")
            val clock = MutableClock("2026-11-08T11:59:59Z")
            val reads = service(clock)
            f.members.forEach { reads.advance(f.chat, it, 1L) }
            val first = reads.readers(f.chat, f.owner, f.messages.single(), null, 2)
            assertTrue(first.detailsAvailable)
            assertEquals(f.members.map { it.value }.sorted().take(2), first.readers.map { it.userId })
            val second = reads.readers(f.chat, f.owner, f.messages.single(), first.nextUserId?.let(::UserId), 2)
            assertEquals(f.members.map { it.value }.sorted().drop(2), second.readers.map { it.userId })
            assertNull(second.nextUserId)
            assertEquals(Instant.parse("2026-11-08T12:00:00Z"), first.detailsExpiresAt.toInstant())
            db.deleteFrom(CHAT_MEMBERS)
                .where(CHAT_MEMBERS.CHAT_ID.eq(f.chat.value), CHAT_MEMBERS.USER_ID.eq(first.readers.first().userId))
                .execute()
            assertEquals(2, reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.size)
            clock.set("2026-11-08T12:00:00Z")
            assertFalse(reads.readers(f.chat, f.owner, f.messages.single(), null, 50).detailsAvailable)
            assertTrue(reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.isEmpty())
            assertEquals("1", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertTrue(db.fetchCount(CHAT_READ_RANGES, CHAT_READ_RANGES.CHAT_ID.eq(f.chat.value)) > 0)
        }

        @Test
        fun `unauthorized removed and deleted targets remain hidden and invalid future progress is rejected`() {
            val f = fixture(messages = 1)
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            val outsider = UserId(user("outside-${newId()}"))
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, outsider, 1L)
                }.status,
            )
            assertEquals(HttpStatus.NOT_FOUND, assertThrows(ApiException::class.java) { reads.summary(f.chat, outsider) }.status)
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.readers(f.chat, f.members.first(), f.messages.single(), null, 50)
                }.status,
            )
            assertEquals(
                HttpStatus.BAD_REQUEST,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, f.members.first(), 2L)
                }.status,
            )
            reads.advance(f.chat, f.members.first(), 1L)
            db.deleteFrom(CHAT_MEMBERS)
                .where(CHAT_MEMBERS.CHAT_ID.eq(f.chat.value), CHAT_MEMBERS.USER_ID.eq(f.members.first().value))
                .execute()
            assertEquals("0", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, f.members.first(), 1L)
                }.status,
            )
            db.update(MESSAGES)
                .set(MESSAGES.BODY, "")
                .set(MESSAGES.DELETED_AT, DSL.currentOffsetDateTime())
                .where(MESSAGES.ID.eq(f.messages.single().value))
                .execute()
            assertFalse(reads.readers(f.chat, f.owner, f.messages.single(), null, 50).detailsAvailable)
            db.update(CHATS).set(CHATS.DELETED_AT, DSL.currentOffsetDateTime()).where(CHATS.ID.eq(f.chat.value)).execute()
            assertEquals(HttpStatus.NOT_FOUND, assertThrows(ApiException::class.java) { reads.summary(f.chat, f.owner) }.status)
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, f.owner, 1L)
                }.status,
            )
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
                }.status,
            )
        }

        @Test
        fun `bounded cleanup removes expired creation buckets while progress and recent details survive`() {
            val f = fixture(messages = 2, createdAt = "2026-11-01T12:00:00Z")
            db.update(MESSAGES)
                .set(MESSAGES.CREATED_AT, OffsetDateTime.parse("2026-11-08T11:00:00Z"))
                .where(MESSAGES.ID.eq(f.messages.last().value))
                .execute()
            val clock = MutableClock("2026-11-08T11:59:59Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), 1L)
            clock.set("2026-11-09T00:00:00Z")
            val repo = JooqReadRepository(db, clock)
            val cleanup = ReadCleanupService(repo, ReadProperties(), tx, clock, ReadMetrics(SimpleMeterRegistry()))
            val first = cleanup.cleanup(1)!!
            assertEquals(1, first.ranges)
            reads.advance(f.chat, f.members.first(), 2L)
            for (attempt in 1..300) {
                if (cleanup.cleanup(1)!!.backlog == 0) break
            }
            assertEquals("2", reads.summary(f.chat, f.members.first()).throughSequence)
            assertFalse(reads.readers(f.chat, f.owner, f.messages.first(), null, 50).detailsAvailable)
            val recent = reads.readers(f.chat, f.owner, f.messages.last(), null, 50)
            assertTrue(recent.detailsAvailable)
            assertEquals(1, recent.readers.size)
            assertEquals(Instant.parse("2026-11-09T00:00:00Z"), recent.readers.single().readAt.toInstant())
            assertEquals(
                0,
                db.fetchCount(
                    CHAT_READ_RANGES,
                    CHAT_READ_RANGES.CHAT_ID.eq(f.chat.value),
                    CHAT_READ_RANGES.EXPIRES_AT.le(OffsetDateTime.parse("2026-11-09T00:00:00Z")),
                ),
            )
        }

        @Test
        fun `new prefix accepted during a clock regression keeps monotonic server timestamps`() {
            val f = fixture(messages = 2)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val first = reads.advance(f.chat, f.members.first(), 1L)
            clock.set("2026-11-02T11:00:00Z")
            val second = reads.advance(f.chat, f.members.first(), 2L)
            assertEquals(first.readAt!!.toInstant(), second.readAt!!.toInstant())
            assertEquals(
                second.readAt.toInstant(),
                reads.readers(f.chat, f.owner, f.messages.last(), null, 50).readers.single().readAt.toInstant(),
            )
        }

        @Test
        fun `cleanup replicas coordinate while an independent reader advances`() {
            val f = fixture(messages = 2)
            val clock = MutableClock("2026-11-08T11:59:59Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), 1L)
            clock.set("2026-11-09T00:00:00Z")
            val repository = JooqReadRepository(db, clock)
            val cleanup = ReadCleanupService(repository, ReadProperties(), tx, clock, ReadMetrics(SimpleMeterRegistry()))
            val locked = CountDownLatch(1)
            val release = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            try {
                val owner = pool.submit(
                    Callable {
                        tx.execute {
                            val result = repository.cleanup(OffsetDateTime.now(clock), 1)
                            locked.countDown()
                            check(release.await(15, TimeUnit.SECONDS))
                            result
                        }
                    },
                )
                assertTrue(locked.await(10, TimeUnit.SECONDS))
                assertNull(cleanup.cleanup(1))
                val progress = pool.submit(Callable { reads.advance(f.chat, f.members.first(), 2L) })
                assertEquals("2", progress.get(10, TimeUnit.SECONDS).throughSequence)
                release.countDown()
                assertEquals(1, owner.get(10, TimeUnit.SECONDS)!!.ranges)
                assertEquals("2", reads.summary(f.chat, f.members.first()).throughSequence)
            } finally {
                release.countDown()
                pool.shutdownNow()
                assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            }
        }

        private fun activeMembership(chatId: ChatId, userId: UserId): Boolean = db.select(CHAT_READ_PROGRESS.ACTIVE_MEMBERSHIP)
            .from(CHAT_READ_PROGRESS)
            .where(CHAT_READ_PROGRESS.CHAT_ID.eq(chatId.value), CHAT_READ_PROGRESS.USER_ID.eq(userId.value))
            .fetchSingle()
            .value1()!!

        @Test
        fun `membership removal and rejoin update indexed peer frontier without losing first read time`() {
            val f = fixture(messages = 1)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val member = f.members.first()
            val first = reads.advance(f.chat, member, 1L)
            db.deleteFrom(CHAT_MEMBERS)
                .where(CHAT_MEMBERS.CHAT_ID.eq(f.chat.value), CHAT_MEMBERS.USER_ID.eq(member.value))
                .execute()
            assertEquals("0", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertFalse(
                activeMembership(f.chat, member),
            )
            db.insertInto(CHAT_MEMBERS, CHAT_MEMBERS.CHAT_ID, CHAT_MEMBERS.USER_ID).values(f.chat.value, member.value).execute()
            assertEquals("1", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            clock.set("2026-11-02T13:00:00Z")
            assertEquals(first.readAt!!.toInstant(), reads.advance(f.chat, member, 1L).readAt!!.toInstant())
            assertEquals(
                first.readAt.toInstant(),
                reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.single().readAt.toInstant(),
            )
        }

        @Test
        fun `membership removal waits for first read transaction then deactivates its summary entry`() {
            val f = fixture(messages = 1)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val repository = JooqReadRepository(db, clock)
            val authorized = CountDownLatch(1)
            val release = CountDownLatch(1)
            val removing = CountDownLatch(1)
            val pool = Executors.newFixedThreadPool(2)
            try {
                val first = pool.submit(
                    Callable {
                        tx.execute {
                            repository.requireMember(f.chat, f.members.first())
                            authorized.countDown()
                            check(release.await(15, TimeUnit.SECONDS))
                            reads.advance(f.chat, f.members.first(), 1L)
                        }
                    },
                )
                assertTrue(authorized.await(10, TimeUnit.SECONDS))
                val removed = pool.submit(
                    Callable {
                        removing.countDown()
                        db.deleteFrom(CHAT_MEMBERS)
                            .where(CHAT_MEMBERS.CHAT_ID.eq(f.chat.value), CHAT_MEMBERS.USER_ID.eq(f.members.first().value))
                            .execute()
                    },
                )
                assertTrue(removing.await(10, TimeUnit.SECONDS))
                assertThrows(java.util.concurrent.TimeoutException::class.java) { removed.get(100, TimeUnit.MILLISECONDS) }
                release.countDown()
                assertEquals("1", first.get(10, TimeUnit.SECONDS)!!.throughSequence)
                assertEquals(1, removed.get(10, TimeUnit.SECONDS))
                assertEquals("0", reads.summary(f.chat, f.owner).maxOtherReadSequence)
                assertFalse(
                    activeMembership(f.chat, f.members.first()),
                )
            } finally {
                release.countDown()
                pool.shutdownNow()
                assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            }
        }

        @Test
        fun `zero progress and final reader page serialize required nullable fields`() {
            val f = fixture(messages = 1)
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            val progress = reads.advance(f.chat, f.members.first(), 0L)
            val serializedProgress = mapper.readTree(mapper.writeValueAsString(progress))
            assertTrue(serializedProgress.has("readAt"))
            assertTrue(serializedProgress.get("readAt").isNull)
            val details = reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
            val serializedDetails = mapper.readTree(mapper.writeValueAsString(details))
            assertTrue(serializedDetails.has("nextUserId"))
            assertTrue(serializedDetails.get("nextUserId").isNull)
            assertTrue(details.detailsAvailable)
            assertTrue(details.readers.isEmpty())
            assertEquals(0, db.fetchCount(CHAT_READ_RANGES, CHAT_READ_RANGES.CHAT_ID.eq(f.chat.value)))
        }

        @Test
        fun `future creation time does not expose receipt detail`() {
            val f = fixture(messages = 1, createdAt = "2026-11-03T12:00:00Z")
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            reads.advance(f.chat, f.members.first(), 1L)
            val details = reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
            assertFalse(details.detailsAvailable)
            assertTrue(details.readers.isEmpty())
        }

        @Test
        fun `small prefixes store only actual creation days without assuming chronological timestamps`() {
            val f = fixture(messages = 3)
            db.update(MESSAGES)
                .set(MESSAGES.CREATED_AT, OffsetDateTime.parse("2026-10-28T13:00:00Z"))
                .where(MESSAGES.ID.eq(f.messages[1].value))
                .execute()
            db.update(MESSAGES)
                .set(MESSAGES.CREATED_AT, OffsetDateTime.parse("2026-11-02T11:00:00Z"))
                .where(MESSAGES.ID.eq(f.messages[2].value))
                .execute()
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            reads.advance(f.chat, f.members.first(), 3L)
            assertEquals(3, db.fetchCount(CHAT_READ_RANGES, CHAT_READ_RANGES.CHAT_ID.eq(f.chat.value)))
            for (id in f.messages) assertEquals(1, reads.readers(f.chat, f.owner, id, null, 50).readers.size)
        }

        @Test
        fun `large skipped prefix retains constant range writes and old message reads retain no expired timestamps`() {
            val f = fixture(messages = 300)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), 300L)
            assertEquals(8, db.fetchCount(CHAT_READ_RANGES, CHAT_READ_RANGES.CHAT_ID.eq(f.chat.value)))
            assertEquals(1, reads.readers(f.chat, f.owner, f.messages.first(), null, 50).readers.size)
            assertEquals(1, reads.readers(f.chat, f.owner, f.messages.last(), null, 50).readers.size)
            val old = fixture(messages = 1, createdAt = "2026-10-25T12:00:00Z")
            reads.advance(old.chat, old.members.first(), 1L)
            assertEquals(0, db.fetchCount(CHAT_READ_RANGES, CHAT_READ_RANGES.CHAT_ID.eq(old.chat.value)))
            assertEquals("1", reads.summary(old.chat, old.members.first()).throughSequence)
            assertFalse(reads.readers(old.chat, old.owner, old.messages.single(), null, 50).detailsAvailable)
        }

        @Test
        fun `notification dedup keys expire independently of durable read timestamps`() {
            val f = fixture(messages = 1)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), 1L)
            clock.set("2026-11-02T12:02:00Z")
            val cleanup =
                ReadCleanupService(JooqReadRepository(db, clock), ReadProperties(), tx, clock, ReadMetrics(SimpleMeterRegistry()))
            assertEquals(1, cleanup.cleanup()!!.notifications)
            assertEquals(1, reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.size)
        }

        @Test
        fun `accepted read timestamps use database precision across first response repeat and details`() {
            val f = fixture(messages = 1)
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00.123456789Z"), ZoneOffset.UTC))
            val first = reads.advance(f.chat, f.members.first(), 1L)
            val repeated = reads.advance(f.chat, f.members.first(), 1L)
            val details = reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
            assertEquals(Instant.parse("2026-11-02T12:00:00.123456Z"), first.readAt!!.toInstant())
            assertEquals(first.readAt.toInstant(), repeated.readAt!!.toInstant())
            assertEquals(first.readAt.toInstant(), details.readers.single().readAt.toInstant())
        }
    }
