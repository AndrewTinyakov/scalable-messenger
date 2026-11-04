package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.chat.web.payload.CreateGroupChatRequest
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxRepository
import com.andrewtinyakov.messenger.read.repository.JooqReadRepository
import com.andrewtinyakov.messenger.read.web.payload.AdvanceReadRequest
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.MessageId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.newId
import com.andrewtinyakov.messenger.shared.web.ApiException
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.jooq.DSLContext
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
import java.time.ZoneId
import java.time.ZoneOffset
import java.util.concurrent.Callable
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference

class ReadServiceTests
    @Autowired
    constructor(
        private val chatService: ChatService,
        private val jooq: DSLContext,
        private val outbox: OutboxRepository,
        private val mapper: ObjectMapper,
        private val tx: TransactionTemplate,
    ) : MessengerIntegrationTest() {
        private class MutableClock(
            initial: String,
        ) : Clock() {
            private val value = AtomicReference(Instant.parse(initial))

            fun set(next: String) {
                value.set(Instant.parse(next))
            }

            override fun instant(): Instant = value.get()

            override fun getZone(): ZoneId = ZoneOffset.UTC

            override fun withZone(zone: ZoneId): Clock = Clock.fixed(instant(), zone)
        }

        private data class Fixture(
            val owner: UserId,
            val members: List<UserId>,
            val chat: ChatId,
            val messages: List<MessageId>,
        )

        private fun fixture(count: Int = 3, messages: Int = 3, createdAt: String = "2026-11-01T12:00:00Z"): Fixture {
            val owner = UserId(user("reads-${newId()}"))
            val members = (1..count).map { UserId(user("reader-${newId()}")) }
            val chat = ChatId(chatService.createGroup(owner, CreateGroupChatRequest("Read receipts", members.map { it.value })).id)
            val ids = (1..messages).map { sequence ->
                MessageId(newId()).also { id ->
                    db.update(
                        "INSERT INTO messages(id,chat_id,sequence,sender_id,body,created_at) VALUES (?,?,?,?,'hello',?::timestamptz)",
                        id.value,
                        chat.value,
                        sequence.toLong(),
                        owner.value,
                        createdAt,
                    )
                }
            }
            db.update("UPDATE chats SET next_sequence=? WHERE id=?", messages.toLong() + 1, chat.value)
            return Fixture(owner, members, chat, ids)
        }

        private fun service(clock: Clock): ReadService = ReadService(
            JooqReadRepository(jooq, clock),
            outbox,
            mapper,
            tx,
            clock,
            ReadMetrics(SimpleMeterRegistry()),
        )

        @Test
        fun `first accepted prefix timestamps survive repeats backwards progress and another device`() {
            val f = fixture()
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val member = f.members.first()
            val first = reads.advance(f.chat, member, AdvanceReadRequest("2"))
            assertEquals("2", first.throughSequence)
            assertEquals(OffsetDateTime.parse("2026-11-02T12:00:00Z"), first.readAt)
            clock.set("2026-11-02T13:00:00Z")
            assertEquals(first.readAt!!.toInstant(), reads.advance(f.chat, member, AdvanceReadRequest("1")).readAt!!.toInstant())
            assertEquals(first.readAt.toInstant(), reads.advance(f.chat, member, AdvanceReadRequest("2")).readAt!!.toInstant())
            val latest = reads.advance(f.chat, member, AdvanceReadRequest("3"))
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
            assertEquals(2, db.queryForObject("SELECT count(*) FROM chat_read_ranges WHERE chat_id=?", Int::class.java, f.chat.value))
            clock.set("2026-11-02T11:00:00Z")
            assertEquals(latest.readAt.toInstant(), reads.advance(f.chat, member, AdvanceReadRequest("3")).readAt!!.toInstant())
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
                            reads.advance(f.chat, f.members.first(), AdvanceReadRequest(sequence.toString()))
                        },
                    )
                }
                start.countDown()
                tasks.forEach { it.get(20, TimeUnit.SECONDS) }
                val others = f.members.drop(1).map { member ->
                    pool.submit(Callable { reads.advance(f.chat, member, AdvanceReadRequest("30")) })
                }
                others.forEach { it.get(20, TimeUnit.SECONDS) }
            } finally {
                pool.shutdownNow()
                assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            }
            assertEquals("30", reads.summary(f.chat, f.members.first()).throughSequence)
            assertEquals(
                0,
                db.queryForObject(
                    """SELECT count(*) FROM chat_read_ranges a JOIN chat_read_ranges b
            ON a.chat_id=b.chat_id AND a.user_id=b.user_id AND a.creation_day=b.creation_day
            AND a.through_sequence<b.through_sequence AND a.through_sequence>b.after_sequence WHERE a.chat_id=?""",
                    Int::class.java,
                    f.chat.value,
                ),
            )
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='reads_changed' AND payload->>'chatId'=?",
                    Int::class.java,
                    f.chat.value,
                ),
            )
            assertEquals(
                1,
                db.queryForObject("SELECT count(*) FROM chat_read_notifications WHERE chat_id=?", Int::class.java, f.chat.value),
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
                        val progress = reads.advance(f.chat, f.members[0], AdvanceReadRequest("1"))
                        claimed.countDown()
                        check(release.await(10, TimeUnit.SECONDS))
                        progress
                    }
                },
            )
            try {
                assertTrue(claimed.await(10, TimeUnit.SECONDS))
                val other = pool.submit(Callable { reads.advance(f.chat, f.members[1], AdvanceReadRequest("2")) })
                assertEquals("2", other.get(2, TimeUnit.SECONDS).throughSequence)
                assertEquals("2", reads.summary(f.chat, f.owner).maxOtherReadSequence)
                assertEquals(
                    0,
                    db.queryForObject(
                        "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='reads_changed' AND payload->>'chatId'=?",
                        Int::class.java,
                        f.chat.value,
                    ),
                )
            } finally {
                release.countDown()
                winner.get(10, TimeUnit.SECONDS)
                pool.shutdownNow()
                assertTrue(pool.awaitTermination(10, TimeUnit.SECONDS))
            }
            assertEquals(
                1,
                db.queryForObject(
                    "SELECT count(*) FROM messenger_outbox_events WHERE payload->>'type'='reads_changed' AND payload->>'chatId'=?",
                    Int::class.java,
                    f.chat.value,
                ),
            )
        }

        @Test
        fun `reader details paginate current members and expire exactly seven days after creation`() {
            val f = fixture(messages = 1, createdAt = "2026-11-01T12:00:00Z")
            val clock = MutableClock("2026-11-08T11:59:59Z")
            val reads = service(clock)
            f.members.forEach { reads.advance(f.chat, it, AdvanceReadRequest("1")) }
            val first = reads.readers(f.chat, f.owner, f.messages.single(), null, 2)
            assertTrue(first.detailsAvailable)
            assertEquals(f.members.map { it.value }.sorted().take(2), first.readers.map { it.userId })
            val second = reads.readers(f.chat, f.owner, f.messages.single(), first.nextUserId, 2)
            assertEquals(f.members.map { it.value }.sorted().drop(2), second.readers.map { it.userId })
            assertNull(second.nextUserId)
            assertEquals(Instant.parse("2026-11-08T12:00:00Z"), first.detailsExpiresAt.toInstant())
            db.update("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", f.chat.value, first.readers.first().userId)
            assertEquals(2, reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.size)
            clock.set("2026-11-08T12:00:00Z")
            assertFalse(reads.readers(f.chat, f.owner, f.messages.single(), null, 50).detailsAvailable)
            assertTrue(reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.isEmpty())
            assertEquals("1", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertTrue(db.queryForObject("SELECT count(*) FROM chat_read_ranges WHERE chat_id=?", Int::class.java, f.chat.value)!! > 0)
        }

        @Test
        fun `unauthorized removed and deleted targets remain hidden and invalid future progress is rejected`() {
            val f = fixture(messages = 1)
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            val outsider = UserId(user("outside-${newId()}"))
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, outsider, AdvanceReadRequest("bad"))
                }.status,
            )
            assertEquals(HttpStatus.NOT_FOUND, assertThrows(ApiException::class.java) { reads.summary(f.chat, outsider) }.status)
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.readers(f.chat, f.members.first(), f.messages.single(), null, 50)
                }.status,
            )
            listOf("01", "-1", "9223372036854775808", "2").forEach { value ->
                assertEquals(
                    HttpStatus.BAD_REQUEST,
                    assertThrows(ApiException::class.java) {
                        reads.advance(f.chat, f.members.first(), AdvanceReadRequest(value))
                    }.status,
                )
            }
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            db.update("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", f.chat.value, f.members.first().value)
            assertEquals("0", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
                }.status,
            )
            db.update("UPDATE messages SET body='',deleted_at=now() WHERE id=?", f.messages.single().value)
            assertFalse(reads.readers(f.chat, f.owner, f.messages.single(), null, 50).detailsAvailable)
            db.update("UPDATE chats SET deleted_at=now() WHERE id=?", f.chat.value)
            assertEquals(HttpStatus.NOT_FOUND, assertThrows(ApiException::class.java) { reads.summary(f.chat, f.owner) }.status)
            assertEquals(
                HttpStatus.NOT_FOUND,
                assertThrows(ApiException::class.java) {
                    reads.advance(f.chat, f.owner, AdvanceReadRequest("1"))
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
            db.update("UPDATE messages SET created_at='2026-11-08T11:00:00Z' WHERE id=?", f.messages.last().value)
            val clock = MutableClock("2026-11-08T11:59:59Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            clock.set("2026-11-09T00:00:00Z")
            val repo = JooqReadRepository(jooq, clock)
            val cleanup = ReadCleanupService(repo, tx, clock, ReadMetrics(SimpleMeterRegistry()))
            val first = cleanup.cleanup(1)!!
            assertEquals(1, first.ranges)
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("2"))
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
                db.queryForObject(
                    "SELECT count(*) FROM chat_read_ranges WHERE chat_id=? AND expires_at <= '2026-11-09T00:00:00Z'",
                    Int::class.java,
                    f.chat.value,
                ),
            )
        }

        @Test
        fun `new prefix accepted during a clock regression keeps monotonic server timestamps`() {
            val f = fixture(messages = 2)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val first = reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            clock.set("2026-11-02T11:00:00Z")
            val second = reads.advance(f.chat, f.members.first(), AdvanceReadRequest("2"))
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
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            clock.set("2026-11-09T00:00:00Z")
            val repository = JooqReadRepository(jooq, clock)
            val cleanup = ReadCleanupService(repository, tx, clock, ReadMetrics(SimpleMeterRegistry()))
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
                val progress = pool.submit(Callable { reads.advance(f.chat, f.members.first(), AdvanceReadRequest("2")) })
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

        @Test
        fun `membership removal and rejoin update indexed peer frontier without losing first read time`() {
            val f = fixture(messages = 1)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            val member = f.members.first()
            val first = reads.advance(f.chat, member, AdvanceReadRequest("1"))
            db.update("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", f.chat.value, member.value)
            assertEquals("0", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            assertFalse(
                db.queryForObject(
                    "SELECT active_membership FROM chat_read_progress WHERE chat_id=? AND user_id=?",
                    Boolean::class.java,
                    f.chat.value,
                    member.value,
                )!!,
            )
            db.update("INSERT INTO chat_members(chat_id,user_id) VALUES (?,?)", f.chat.value, member.value)
            assertEquals("1", reads.summary(f.chat, f.owner).maxOtherReadSequence)
            clock.set("2026-11-02T13:00:00Z")
            assertEquals(first.readAt!!.toInstant(), reads.advance(f.chat, member, AdvanceReadRequest("1")).readAt!!.toInstant())
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
            val repository = JooqReadRepository(jooq, clock)
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
                            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
                        }
                    },
                )
                assertTrue(authorized.await(10, TimeUnit.SECONDS))
                val removed = pool.submit(
                    Callable {
                        removing.countDown()
                        db.update("DELETE FROM chat_members WHERE chat_id=? AND user_id=?", f.chat.value, f.members.first().value)
                    },
                )
                assertTrue(removing.await(10, TimeUnit.SECONDS))
                assertThrows(java.util.concurrent.TimeoutException::class.java) { removed.get(100, TimeUnit.MILLISECONDS) }
                release.countDown()
                assertEquals("1", first.get(10, TimeUnit.SECONDS)!!.throughSequence)
                assertEquals(1, removed.get(10, TimeUnit.SECONDS))
                assertEquals("0", reads.summary(f.chat, f.owner).maxOtherReadSequence)
                assertFalse(
                    db.queryForObject(
                        "SELECT active_membership FROM chat_read_progress WHERE chat_id=? AND user_id=?",
                        Boolean::class.java,
                        f.chat.value,
                        f.members.first().value,
                    )!!,
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
            val progress = reads.advance(f.chat, f.members.first(), AdvanceReadRequest("0"))
            val serializedProgress = mapper.readTree(mapper.writeValueAsString(progress))
            assertTrue(serializedProgress.has("readAt"))
            assertTrue(serializedProgress.get("readAt").isNull)
            val details = reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
            val serializedDetails = mapper.readTree(mapper.writeValueAsString(details))
            assertTrue(serializedDetails.has("nextUserId"))
            assertTrue(serializedDetails.get("nextUserId").isNull)
            assertTrue(details.detailsAvailable)
            assertTrue(details.readers.isEmpty())
            assertEquals(0, db.queryForObject("SELECT count(*) FROM chat_read_ranges WHERE chat_id=?", Int::class.java, f.chat.value))
        }

        @Test
        fun `future creation time does not expose receipt detail`() {
            val f = fixture(messages = 1, createdAt = "2026-11-03T12:00:00Z")
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            val details = reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
            assertFalse(details.detailsAvailable)
            assertTrue(details.readers.isEmpty())
        }

        @Test
        fun `small prefixes store only actual creation days without assuming chronological timestamps`() {
            val f = fixture(messages = 3)
            db.update("UPDATE messages SET created_at='2026-10-28T13:00:00Z' WHERE id=?", f.messages[1].value)
            db.update("UPDATE messages SET created_at='2026-11-02T11:00:00Z' WHERE id=?", f.messages[2].value)
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00Z"), ZoneOffset.UTC))
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("3"))
            assertEquals(3, db.queryForObject("SELECT count(*) FROM chat_read_ranges WHERE chat_id=?", Int::class.java, f.chat.value))
            for (id in f.messages) assertEquals(1, reads.readers(f.chat, f.owner, id, null, 50).readers.size)
        }

        @Test
        fun `large skipped prefix retains constant range writes and old message reads retain no expired timestamps`() {
            val f = fixture(messages = 300)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("300"))
            assertEquals(8, db.queryForObject("SELECT count(*) FROM chat_read_ranges WHERE chat_id=?", Int::class.java, f.chat.value))
            assertEquals(1, reads.readers(f.chat, f.owner, f.messages.first(), null, 50).readers.size)
            assertEquals(1, reads.readers(f.chat, f.owner, f.messages.last(), null, 50).readers.size)
            val old = fixture(messages = 1, createdAt = "2026-10-25T12:00:00Z")
            reads.advance(old.chat, old.members.first(), AdvanceReadRequest("1"))
            assertEquals(0, db.queryForObject("SELECT count(*) FROM chat_read_ranges WHERE chat_id=?", Int::class.java, old.chat.value))
            assertEquals("1", reads.summary(old.chat, old.members.first()).throughSequence)
            assertFalse(reads.readers(old.chat, old.owner, old.messages.single(), null, 50).detailsAvailable)
        }

        @Test
        fun `notification dedup keys expire independently of durable read timestamps`() {
            val f = fixture(messages = 1)
            val clock = MutableClock("2026-11-02T12:00:00Z")
            val reads = service(clock)
            reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            clock.set("2026-11-02T12:02:00Z")
            val cleanup = ReadCleanupService(JooqReadRepository(jooq, clock), tx, clock, ReadMetrics(SimpleMeterRegistry()))
            assertEquals(1, cleanup.cleanup()!!.notifications)
            assertEquals(1, reads.readers(f.chat, f.owner, f.messages.single(), null, 50).readers.size)
        }

        @Test
        fun `accepted read timestamps use database precision across first response repeat and details`() {
            val f = fixture(messages = 1)
            val reads = service(Clock.fixed(Instant.parse("2026-11-02T12:00:00.123456789Z"), ZoneOffset.UTC))
            val first = reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            val repeated = reads.advance(f.chat, f.members.first(), AdvanceReadRequest("1"))
            val details = reads.readers(f.chat, f.owner, f.messages.single(), null, 50)
            assertEquals(Instant.parse("2026-11-02T12:00:00.123456Z"), first.readAt!!.toInstant())
            assertEquals(first.readAt.toInstant(), repeated.readAt!!.toInstant())
            assertEquals(first.readAt.toInstant(), details.readers.single().readAt.toInstant())
        }
    }
