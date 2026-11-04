package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.transaction.support.TransactionTemplate
import java.sql.SQLException
import java.time.Instant
import java.time.OffsetDateTime
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class OutboxRepositoryTests
    @Autowired
    constructor(
        private val outboxRepository: OutboxRepository,
        private val tx: TransactionTemplate,
    ) : MessengerIntegrationTest() {
        @Test
        fun `durable outbox rejects message and quote content`() {
            for (field in listOf("body", "replyBody")) {
                val id = EventId(newId())
                assertThrows(DataIntegrityViolationException::class.java) {
                    outboxRepository.enqueue(listOf(OutboxMessage(id, "user:${newId()}", """{"$field":"retained content"}""")))
                }
                assertEquals(0, db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE id=?", Int::class.java, id.value))
            }
        }

        @Test
        fun `expired group prefixes transfer ownership without changing publication order`() {
            val room = "group:${newId()}"
            val ids = List(3) { EventId(newId()) }
            outboxRepository.enqueue(ids.map { OutboxMessage(it, room, "{}") })
            ids.forEach { db.update("UPDATE messenger_outbox_events SET created_at='1970-01-01T00:00:00Z' WHERE id=?", it.value) }
            val now = OffsetDateTime.now()
            val anchor = tx.execute { outboxRepository.claim(now, 1000, "expired-a", now.plusSeconds(30)) }.single { it.room == room }
            val tail = tx.execute { outboxRepository.claimGroupTail(anchor, now, 2, "expired-a", now.plusSeconds(30)) }
            val future = now.plusSeconds(31)
            val replacement = tx.execute { outboxRepository.claim(future, 1000, "expired-b", future.plusSeconds(30)) }.single {
                it.room ==
                    room
            }
            val replacementTail = tx.execute {
                outboxRepository.claimGroupTail(replacement, future, 2, "expired-b", future.plusSeconds(30))
            }
            assertEquals(listOf(anchor) + tail, listOf(replacement) + replacementTail)
            assertEquals(
                emptyList<OutboxMessage>(),
                tx.execute {
                    outboxRepository.claimGroupTail(anchor, future, 2, "expired-a", future.plusSeconds(30))
                },
            )
            assertThrows(IllegalStateException::class.java) { outboxRepository.complete(ids, "expired-a") }
            outboxRepository.complete(ids, "expired-b")
        }

        @Test
        fun `group prefix stops before an unavailable earlier event`() {
            val room = "group:${newId()}"
            val ids = List(3) { EventId(newId()) }
            outboxRepository.enqueue(ids.map { OutboxMessage(it, room, "{}") })
            val now = OffsetDateTime.now()
            val lease = now.plusSeconds(30)
            val anchor = tx.execute { outboxRepository.claim(now, 1000, "barrier-a", lease) }.single { it.room == room }
            db.update("UPDATE messenger_outbox_events SET lease_owner='barrier-b', lease_until=? WHERE id=?", lease, ids[1].value)
            assertEquals(emptyList<OutboxMessage>(), tx.execute { outboxRepository.claimGroupTail(anchor, now, 10, "barrier-a", lease) })
            outboxRepository.complete(listOf(ids[0]), "barrier-a")
            outboxRepository.complete(listOf(ids[1]), "barrier-b")
            val last = tx.execute { outboxRepository.claim(now, 1000, "barrier-a", lease) }.single { it.room == room }
            assertEquals(ids[2], last.id)
            outboxRepository.complete(listOf(last.id), "barrier-a")
        }

        @Test
        fun `group tail claims are bounded and cannot overtake another publisher`() {
            val room = "group:${newId()}"
            val ids = List(5) { EventId(newId()) }
            outboxRepository.enqueue(ids.map { OutboxMessage(it, room, "{}") })
            ids.forEach { db.update("UPDATE messenger_outbox_events SET created_at='1980-01-01T00:00:00Z' WHERE id=?", it.value) }
            val now = OffsetDateTime.now()
            val lease = now.plusSeconds(30)
            val anchor = tx.execute { outboxRepository.claim(now, 1000, "prefix-a", lease) }.single { it.room == room }
            val tail = tx.execute { outboxRepository.claimGroupTail(anchor, now, 2, "prefix-a", lease) }
            assertEquals(
                List(3) { Instant.parse("1980-01-01T00:00:00Z") },
                (listOf(anchor) + tail).map { it.createdAt?.toInstant() },
            )
            assertEquals(ids.subList(1, 3), tail.map { it.id })
            assertTrue(tail.all { it.groupPublicationOrder!! > anchor.groupPublicationOrder!! })
            assertEquals(emptyList<OutboxMessage>(), tx.execute { outboxRepository.claimGroupTail(anchor, now, 2, "prefix-b", lease) })
            outboxRepository.complete(listOf(anchor.id), "prefix-a")
            assertEquals(
                emptyList<OutboxMessage>(),
                tx.execute { outboxRepository.claim(now, 1000, "prefix-b", lease) }.filter {
                    it.room ==
                        room
                },
            )
            outboxRepository.complete(tail.map { it.id }, "prefix-a")
            val next = tx.execute { outboxRepository.claim(now, 1000, "prefix-b", lease) }.single { it.room == room }
            assertEquals(ids[3], next.id)
            outboxRepository.complete(listOf(next.id), "prefix-b")
            val last = tx.execute { outboxRepository.claim(now, 1000, "prefix-b", lease) }.single { it.room == room }
            assertEquals(ids[4], last.id)
            outboxRepository.complete(listOf(last.id), "prefix-b")
        }

        @Test
        fun `room kind follows the room address`() {
            val userEvent = EventId(newId())
            val groupEvent = EventId(newId())
            outboxRepository.enqueue(
                listOf(
                    OutboxMessage(userEvent, "user:${newId()}", "{}"),
                    OutboxMessage(groupEvent, "group:${newId()}", "{}"),
                ),
            )

            assertEquals(
                "USER",
                db.queryForObject("SELECT room_kind::text FROM messenger_outbox_events WHERE id=?", String::class.java, userEvent.value),
            )
            assertEquals(
                "GROUP",
                db.queryForObject("SELECT room_kind::text FROM messenger_outbox_events WHERE id=?", String::class.java, groupEvent.value),
            )

            db.update("UPDATE messenger_outbox_events SET room=? WHERE id=?", "group:${newId()}", userEvent.value)

            assertEquals(
                "GROUP",
                db.queryForObject("SELECT room_kind::text FROM messenger_outbox_events WHERE id=?", String::class.java, userEvent.value),
            )
        }

        @Test
        fun `unknown room prefixes reject the entire enqueue batch`() {
            listOf("groupp:", "usr:").forEach { prefix ->
                val validEvent = EventId(newId())
                val invalidEvent = EventId(newId())

                val failure = assertThrows(DataIntegrityViolationException::class.java) {
                    outboxRepository.enqueue(
                        listOf(
                            OutboxMessage(validEvent, "user:${newId()}", "{}"),
                            OutboxMessage(invalidEvent, "$prefix${newId()}", "{}"),
                        ),
                    )
                }

                assertEquals("23502", (failure.mostSpecificCause as SQLException).sqlState)
                assertEquals(
                    0,
                    db.queryForObject(
                        "SELECT count(*) FROM messenger_outbox_events WHERE id IN (?, ?)",
                        Int::class.java,
                        validEvent.value,
                        invalidEvent.value,
                    ),
                )
            }
        }

        @Test
        fun `concurrent publishers skip locked events and claim distinct ordered work`() {
            val room = "user:${newId()}"
            val ids = List(3) { EventId(newId()) }.sortedBy { it.value }
            outboxRepository.enqueue(messages = ids.map { OutboxMessage(id = it, room = room, payload = "{}") })
            ids.forEach {
                db.update("UPDATE messenger_outbox_events SET created_at='1990-01-01T00:00:00Z' WHERE id=?", it.value)
            }
            val now = OffsetDateTime.now()
            val locked = CountDownLatch(1)
            val release = CountDownLatch(1)
            val first = CompletableFuture.supplyAsync {
                tx.execute {
                    val claimed = outboxRepository.claim(now = now, limit = 1, owner = "claim-first", leaseUntil = now.plusSeconds(30))
                    locked.countDown()
                    check(release.await(10, TimeUnit.SECONDS))
                    claimed
                }
            }

            try {
                assertTrue(locked.await(10, TimeUnit.SECONDS))
                val second = CompletableFuture.supplyAsync {
                    tx.execute {
                        outboxRepository.claim(now = now, limit = 2, owner = "claim-second", leaseUntil = now.plusSeconds(30))
                    }
                }.get(5, TimeUnit.SECONDS)

                assertEquals(ids.drop(1), second.map { it.id })
                outboxRepository.complete(ids = second.map { it.id }, owner = "claim-second")
            } finally {
                release.countDown()
            }
            assertEquals(ids.take(1), first.get(5, TimeUnit.SECONDS).map { it.id })
            outboxRepository.complete(ids = ids.take(1), owner = "claim-first")
        }

        @Test
        fun `outbox completion deletes only rows leased by this publisher`() {
            val owned = newId()
            val other = newId()
            db.update(
                "INSERT INTO messenger_outbox_events(id,room,payload,lease_owner) VALUES (?,'user:test','{}'::jsonb,'publisher-a')," +
                    "(?,'user:test','{}'::jsonb,'publisher-b')",
                owned,
                other,
            )

            outboxRepository.complete(listOf(EventId(owned)), "publisher-a")

            assertEquals(0, db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE id=?", Int::class.java, owned))
            assertEquals(1, db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE id=?", Int::class.java, other))
        }

        @Test
        fun `group room events wait for earlier publication across publisher claims`() {
            val room = "group:${newId()}"
            val ids = listOf(newId(), newId()).sortedDescending()
            outboxRepository.enqueue(
                listOf(
                    OutboxMessage(EventId(ids[0]), room, """{"type":"member_removed"}"""),
                    OutboxMessage(EventId(ids[1]), room, """{"type":"message_saved"}"""),
                ),
            )
            ids.forEach {
                db.update("UPDATE messenger_outbox_events SET created_at='1989-01-01T00:00:00Z' WHERE id=?", it)
            }
            val now = OffsetDateTime.now()

            val firstClaim = tx.execute { outboxRepository.claim(now, 1000, "group-order-first", now.plusSeconds(30)) }
            assertEquals(listOf(EventId(ids[0])), firstClaim.filter { it.room == room }.map { it.id })

            val blockedClaim = tx.execute { outboxRepository.claim(now, 1000, "group-order-second", now.plusSeconds(30)) }
            assertEquals(emptyList<String>(), blockedClaim.filter { it.room == room }.map { it.id })

            outboxRepository.complete(listOf(EventId(ids[0])), "group-order-first")
            val secondClaim = tx.execute { outboxRepository.claim(now, 1000, "group-order-second", now.plusSeconds(30)) }
            assertEquals(listOf(EventId(ids[1])), secondClaim.filter { it.room == room }.map { it.id })
            outboxRepository.complete(listOf(EventId(ids[1])), "group-order-second")
        }
    }
