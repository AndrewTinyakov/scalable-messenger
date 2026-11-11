package com.andrewtinyakov.messenger.infrastructure.outbox.service

import com.andrewtinyakov.messenger.infrastructure.outbox.MemoryOutbox
import com.andrewtinyakov.messenger.infrastructure.outbox.config.MAX_EVENT_BYTES
import com.andrewtinyakov.messenger.infrastructure.outbox.config.PublisherProperties
import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.monitoring.OutboxMetrics
import com.andrewtinyakov.messenger.infrastructure.outbox.outboxEvent
import com.andrewtinyakov.messenger.infrastructure.outbox.outboxTransactions
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxClaimRepository
import com.andrewtinyakov.messenger.shared.id.newId
import io.micrometer.core.instrument.Meter
import io.micrometer.core.instrument.config.MeterFilter
import io.micrometer.core.instrument.config.MeterFilterReply
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.doThrow
import org.mockito.Mockito.mock
import org.mockito.Mockito.never
import org.mockito.Mockito.verify
import org.mockito.Mockito.`when`
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.Duration
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

class OutboxPublicationServiceTests {
    @Test
    fun `tail claim failure rolls back all room claims before publication`() {
        val rows = List(2) {
            val room = "group:test-${newId()}"
            List(2) { order -> outboxEvent(room).copy(groupPublicationOrder = order.toLong() + 1) }
        }.flatten()
        val storage = MemoryOutbox(rows)
        val failure = IllegalStateException("Tail claim failed")
        val claimed = mutableListOf<OutboxMessage>()
        var tails = 0
        val repository = object : OutboxClaimRepository by storage {
            override fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<OutboxMessage> =
                storage.claim(now, limit, owner, leaseUntil).also { claimed.addAll(it) }

            override fun claimGroupTail(
                anchor: OutboxMessage,
                now: OffsetDateTime,
                limit: Int,
                owner: String,
                leaseUntil: OffsetDateTime,
            ): List<OutboxMessage> {
                val tail = storage.claimGroupTail(anchor, now, limit, owner, leaseUntil)
                claimed.addAll(tail)
                if (++tails == 2) throw failure
                return tail
            }
        }
        val manager = mock(PlatformTransactionManager::class.java)
        val status = mock(TransactionStatus::class.java)
        `when`(manager.getTransaction(any())).thenReturn(status)
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val metrics = SimpleMeterRegistry()
        val service = publicationService(
            repository,
            OutboxEventPublisher { published.add(it) },
            PublisherProperties(concurrency = 2, roomBatchSize = 2),
            metrics,
            TransactionTemplate(manager),
        )

        assertEquals(failure, assertThrows(IllegalStateException::class.java) { service.publishBatch() })
        assertEquals(rows.toSet(), claimed.toSet())
        assertTrue(published.isEmpty())
        verify(manager).rollback(status)
        verify(manager, never()).commit(status)
        assertEquals(0.0, metrics.get("messenger.outbox.claimed").counter().count())
        assertBatch(metrics, "failed")
        assertPhase(metrics, "claim", "failure")
    }

    @Test
    fun `claim commit failure does not count claimed work or begin publication`() {
        val row = outboxEvent()
        val manager = mock(PlatformTransactionManager::class.java)
        val status = mock(TransactionStatus::class.java)
        `when`(manager.getTransaction(any())).thenReturn(status)
        doThrow(IllegalStateException("Commit failed")).`when`(manager).commit(status)
        val metrics = SimpleMeterRegistry()
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            MemoryOutbox(listOf(row)),
            OutboxEventPublisher { published.add(it) },
            metrics = metrics,
            tx = TransactionTemplate(manager),
        )

        assertThrows(IllegalStateException::class.java) { service.publishBatch() }

        assertTrue(published.isEmpty())
        assertEquals(0.0, metrics.get("messenger.outbox.claimed").counter().count())
        assertEquals(0.0, metrics.find("messenger.outbox.publish").counters().sumOf { it.count() })
        assertBatch(metrics, "failed")
        assertPhase(metrics, "claim", "failure")
    }

    @Test
    fun `competing group prefixes share both item and byte budgets`() {
        val settings = listOf(
            PublisherProperties(batchSize = 3, batchBytes = 10 * MAX_EVENT_BYTES, concurrency = 2, roomBatchSize = 3),
            PublisherProperties(batchSize = 10, batchBytes = 3 * MAX_EVENT_BYTES, concurrency = 2, roomBatchSize = 3),
        )
        for (properties in settings) {
            val rows = List(2) {
                val room = "group:test-${newId()}"
                List(3) { order -> outboxEvent(room).copy(groupPublicationOrder = order.toLong() + 1) }
            }.flatten()
            val repository = MemoryOutbox(rows)
            val started = CountDownLatch(2)
            val published = ConcurrentLinkedQueue<OutboxMessage>()
            val service = publicationService(
                repository,
                OutboxEventPublisher {
                    if (it.groupPublicationOrder == 1L) {
                        started.countDown()
                        check(started.await(2, TimeUnit.SECONDS))
                    }
                    published.add(it)
                },
                properties,
            )
            assertEquals(3, service.publishBatch())
            assertEquals(3, published.size)
            assertEquals(3, repository.remaining().size)
            published.groupBy { it.room }.values.forEach { prefix ->
                assertEquals((1L..prefix.size.toLong()).toList(), prefix.map { it.groupPublicationOrder })
            }
        }
    }

    @Test
    fun `unused group tail budget remains available to another room`() {
        val first = outboxEvent().copy(groupPublicationOrder = 1)
        val room = "group:test-${newId()}"
        val ordered = List(5) { outboxEvent(room).copy(groupPublicationOrder = it.toLong() + 1) }
        val storage = MemoryOutbox(listOf(first) + ordered)
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            storage,
            OutboxEventPublisher { published.add(it) },
            PublisherProperties(concurrency = 2, roomBatchSize = 3, batchBytes = 4 * MAX_EVENT_BYTES),
        )

        assertEquals(4, service.publishBatch())
        assertEquals((listOf(first) + ordered.take(3)).toSet(), published.toSet())
        assertEquals(ordered.take(3), published.filter { it.room == room })
        assertEquals(ordered.takeLast(2), storage.remaining())
    }

    @Test
    fun `bounded group prefixes complete while an unrelated room is blocked`() {
        val room = "group:test-${newId()}"
        val ordered = List(3) { outboxEvent(room).copy(groupPublicationOrder = it.toLong() + 1) }
        val slow = outboxEvent()
        val storage = MemoryOutbox(ordered + slow)
        val healthyCompleted = CountDownLatch(1)
        val slowStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        val repository = object : OutboxClaimRepository by storage {
            override fun complete(ids: Collection<EventId>, owner: String) {
                storage.complete(ids, owner)
                if (ordered[1].id in ids) healthyCompleted.countDown()
            }
        }
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            repository,
            OutboxEventPublisher {
                if (it.id == slow.id) {
                    slowStarted.countDown()
                    check(release.await(5, TimeUnit.SECONDS))
                }
                published.add(it)
            },
            PublisherProperties(roomBatchSize = 2, batchBytes = 3 * MAX_EVENT_BYTES),
        )
        val batch = CompletableFuture.supplyAsync { service.publishBatch() }
        try {
            assertTrue(slowStarted.await(2, TimeUnit.SECONDS))
            assertTrue(healthyCompleted.await(2, TimeUnit.SECONDS))
            assertEquals(listOf(ordered[2], slow), storage.remaining())
        } finally {
            release.countDown()
        }
        assertEquals(3, batch.get(5, TimeUnit.SECONDS))
        assertEquals(ordered.take(2), published.filter { it.room == room })
        assertEquals(1, service.publishBatch())
        assertTrue(storage.remaining().isEmpty())
    }

    @Test
    fun `independent rooms publish concurrently`() {
        val rows = listOf(outboxEvent(), outboxEvent())
        val repository = MemoryOutbox(initial = rows)
        val started = CountDownLatch(2)
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            outboxClaimRepository = repository,
            outboxEventPublisher = OutboxEventPublisher { message ->
                started.countDown()
                assertTrue(started.await(1, TimeUnit.SECONDS))
                published.add(message)
            },
        )

        assertEquals(2, service.publishBatch())
        assertEquals(rows.toSet(), published.toSet())
        assertTrue(repository.remaining().isEmpty())
    }

    @Test
    fun `events within each room publish in claim order`() {
        val room = "user:test-${newId()}"
        val ordered = List(8) { outboxEvent(targetRoom = room) }
        val rows = ordered.zip(List(8) { outboxEvent() }).flatMap { listOf(it.first, it.second) }
        val repository = MemoryOutbox(initial = rows)
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            outboxClaimRepository = repository,
            outboxEventPublisher = OutboxEventPublisher { published.add(it) },
        )

        assertEquals(rows.size, service.publishBatch())
        assertEquals(ordered, published.filter { it.room == room })
        assertTrue(repository.remaining().isEmpty())
    }

    @Test
    fun `failure keeps the failed event and its room tail while completing successful publications`() {
        val first = outboxEvent().copy(groupPublicationOrder = 1)
        val failed = outboxEvent(targetRoom = first.room).copy(groupPublicationOrder = 2)
        val later = outboxEvent(targetRoom = first.room).copy(groupPublicationOrder = 3)
        val healthy = outboxEvent()
        val repository = MemoryOutbox(initial = listOf(first, failed, later, healthy))
        val attempted = ConcurrentLinkedQueue<OutboxMessage>()
        val metrics = SimpleMeterRegistry()
        val service = publicationService(
            outboxClaimRepository = repository,
            outboxEventPublisher = OutboxEventPublisher { message ->
                attempted.add(message)
                if (message.id == failed.id) error("Publication failed")
            },
            metrics = metrics,
        )

        assertEquals(2, service.publishBatch())
        assertEquals(listOf(failed, later), repository.remaining())
        assertFalse(attempted.contains(later))
        assertEquals(2.0, metrics.get("messenger.outbox.publish").tag("result", "success").counter().count())
        assertEquals(1.0, metrics.get("messenger.outbox.publish").tag("result", "failure").counter().count())
        assertBatch(metrics, "failed")
        assertPhase(metrics, "claim", "success")
        assertPhase(metrics, "publish", "failure")
        assertEquals(2.0, metrics.get("messenger.outbox.retained").tag("reason", "publish_failure").counter().count())
    }

    @Test
    fun `claim respects the event byte budget across batches`() {
        val rows = listOf(outboxEvent(), outboxEvent())
        val repository = MemoryOutbox(initial = rows)
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            outboxClaimRepository = repository,
            outboxEventPublisher = OutboxEventPublisher { published.add(it) },
            properties = PublisherProperties(batchBytes = MAX_EVENT_BYTES),
        )

        assertEquals(1, service.publishBatch())
        assertEquals(listOf(rows[1]), repository.remaining())
        assertEquals(1, service.publishBatch())
        assertEquals(rows, published.toList())
        assertTrue(repository.remaining().isEmpty())
    }

    @Test
    fun `oversized UTF-8 payload keeps its room pending without reaching the transport`() {
        val oversized = outboxEvent().copy(payload = "é".repeat(MAX_EVENT_BYTES / 2 + 1))
        val later = outboxEvent(targetRoom = oversized.room)
        val healthy = outboxEvent()
        val repository = MemoryOutbox(initial = listOf(oversized, later, healthy))
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            outboxClaimRepository = repository,
            outboxEventPublisher = OutboxEventPublisher { published.add(it) },
        )

        assertEquals(1, service.publishBatch())
        assertEquals(listOf(healthy), published.toList())
        assertEquals(listOf(oversized, later), repository.remaining())
    }

    @Test
    fun `empty polling records a separate batch and claim observation`() {
        val metrics = SimpleMeterRegistry()
        val service = publicationService(MemoryOutbox(emptyList()), OutboxEventPublisher { error("No event expected") }, metrics = metrics)

        assertEquals(0, service.publishBatch())
        assertBatch(metrics, "empty")
        assertPhase(metrics, "claim", "success")
        assertEquals(0L, metrics.find("messenger.outbox.stage").tag("phase", "publish").timers().sumOf { it.count() })
    }

    @Test
    fun `completed work has its own batch and phase observations`() {
        val row = outboxEvent()
        val storage = MemoryOutbox(listOf(row))
        val metrics = SimpleMeterRegistry()
        val service = publicationService(storage, OutboxEventPublisher {}, metrics = metrics)

        assertEquals(1, service.publishBatch())
        assertTrue(storage.remaining().isEmpty())
        assertBatch(metrics, "work")
        for (phase in listOf("claim", "publish", "complete")) assertPhase(metrics, phase, "success")
    }

    @Test
    fun `publication age uses persisted row creation time before each transport attempt`() {
        val clock = Clock.fixed(Instant.parse("2026-11-03T12:00:00Z"), ZoneOffset.UTC)
        val now = OffsetDateTime.now(clock)
        val rows = listOf(
            outboxEvent("group:test").copy(createdAt = now.minusNanos(125_000_000)),
            outboxEvent("user:test").copy(createdAt = now),
        )
        val metrics = SimpleMeterRegistry()
        val storage = MemoryOutbox(rows)
        val service = publicationService(
            storage,
            OutboxEventPublisher { row ->
                val kind = if (row.room == "group:test") "group" else "user"
                val age = metrics.get("messenger.outbox.publication.age").tag("room_kind", kind).timer()
                assertEquals(1L, age.count())
                assertEquals(if (kind == "group") 125.0 else 0.0, age.totalTime(TimeUnit.MILLISECONDS))
                assertEquals(
                    listOf(1.0, 5.0, 10.0, 25.0, 50.0, 100.0, 250.0, 500.0, 1000.0, 2500.0, 5000.0, 10000.0),
                    age.takeSnapshot().histogramCounts().map { it.bucket(TimeUnit.MILLISECONDS) },
                )
            },
            metrics = metrics,
            clock = clock,
        )

        assertEquals(2, service.publishBatch())
        assertTrue(storage.remaining().isEmpty())
        assertEquals(2, metrics.find("messenger.outbox.publication.age").timers().size)
        assertEquals(0.0, metrics.find("messenger.outbox.publication.age.invalid").counters().sumOf { it.count() })
    }

    @Test
    fun `missing and future row timestamps skip age samples while publications complete`() {
        val clock = Clock.fixed(Instant.parse("2026-11-03T12:00:00Z"), ZoneOffset.UTC)
        val rows = listOf(
            outboxEvent("group:test"),
            outboxEvent("user:test").copy(createdAt = OffsetDateTime.now(clock).plusNanos(1)),
        )
        val metrics = SimpleMeterRegistry()
        val storage = MemoryOutbox(rows)
        val published = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(storage, OutboxEventPublisher { published.add(it) }, metrics = metrics, clock = clock)

        assertEquals(2, service.publishBatch())
        assertEquals(rows.toSet(), published.toSet())
        assertTrue(storage.remaining().isEmpty())
        assertEquals(0L, metrics.find("messenger.outbox.publication.age").timers().sumOf { it.count() })
        assertEquals(
            1.0,
            metrics.get("messenger.outbox.publication.age.invalid").tags("room_kind", "group", "reason", "missing").counter().count(),
        )
        assertEquals(
            1.0,
            metrics.get("messenger.outbox.publication.age.invalid").tags("room_kind", "user", "reason", "future").counter().count(),
        )
    }

    @Test
    fun `age meters are registered before publication and reused for each attempt`() {
        for (createdAt in listOf(OffsetDateTime.parse("2026-11-03T11:59:59Z"), null)) {
            val row = outboxEvent().copy(createdAt = createdAt)
            val storage = MemoryOutbox(listOf(row))
            val metrics = SimpleMeterRegistry()
            val service = publicationService(
                storage,
                OutboxEventPublisher {},
                metrics = metrics,
                clock = Clock.fixed(Instant.parse("2026-11-03T12:00:00Z"), ZoneOffset.UTC),
            )

            metrics.config().meterFilter(object : MeterFilter {
                override fun accept(id: Meter.Id): MeterFilterReply {
                    if (id.name.startsWith("messenger.outbox.publication.age")) error("Age metric registration failed")
                    return MeterFilterReply.NEUTRAL
                }
            })
            assertEquals(1, service.publishBatch())
            assertTrue(storage.remaining().isEmpty())
            assertEquals(1.0, metrics.get("messenger.outbox.publish").tag("result", "success").counter().count())
        }
    }

    @Test
    fun `completion failure counts confirmed publications still pending for retry`() {
        val row = outboxEvent()
        val storage = MemoryOutbox(listOf(row))
        val repository = object : OutboxClaimRepository by storage {
            override fun complete(ids: Collection<EventId>, owner: String) {
                error("Completion failed")
            }
        }
        val metrics = SimpleMeterRegistry()
        val service = publicationService(repository, OutboxEventPublisher {}, metrics = metrics)

        assertThrows(java.util.concurrent.ExecutionException::class.java) { service.publishBatch() }
        assertEquals(listOf(row), storage.remaining())
        assertBatch(metrics, "failed")
        assertPhase(metrics, "publish", "success")
        assertPhase(metrics, "complete", "failure")
        assertEquals(1.0, metrics.get("messenger.outbox.publish").tag("result", "success").counter().count())
        assertEquals(1.0, metrics.get("messenger.outbox.retained").tag("reason", "complete_failure").counter().count())
    }

    @Test
    fun `lease work deadline counts unattempted rows without publishing them`() {
        val first = outboxEvent().copy(groupPublicationOrder = 1)
        val second = outboxEvent(first.room).copy(groupPublicationOrder = 2)
        val storage = MemoryOutbox(listOf(first, second))
        val metrics = SimpleMeterRegistry()
        val attempted = ConcurrentLinkedQueue<OutboxMessage>()
        val service = publicationService(
            storage,
            OutboxEventPublisher {
                attempted.add(it)
                Thread.sleep(2100)
            },
            PublisherProperties(lease = Duration.ofSeconds(5), publishTimeout = Duration.ofSeconds(1)),
            metrics,
        )

        assertEquals(1, service.publishBatch())
        assertEquals(listOf(first), attempted.toList())
        assertEquals(listOf(second), storage.remaining())
        assertBatch(metrics, "work")
        assertPhase(metrics, "publish", "deadline")
        assertEquals(1.0, metrics.get("messenger.outbox.retained").tag("reason", "deadline").counter().count())
    }

    private fun assertBatch(metrics: SimpleMeterRegistry, outcome: String) {
        assertEquals(1L, metrics.get("messenger.outbox.batch").tag("outcome", outcome).timer().count())
        assertEquals(1L, metrics.find("messenger.outbox.batch").timers().sumOf { it.count() })
    }

    private fun assertPhase(metrics: SimpleMeterRegistry, phase: String, outcome: String) {
        assertEquals(1L, metrics.get("messenger.outbox.stage").tags("phase", phase, "outcome", outcome).timer().count())
    }

    private fun publicationService(
        outboxClaimRepository: OutboxClaimRepository,
        outboxEventPublisher: OutboxEventPublisher,
        properties: PublisherProperties = PublisherProperties(),
        metrics: SimpleMeterRegistry = SimpleMeterRegistry(),
        tx: TransactionTemplate = outboxTransactions(),
        clock: Clock = Clock.systemUTC(),
    ): OutboxPublicationService =
        OutboxPublicationService(
            outboxClaimRepository = outboxClaimRepository,
            tx = tx,
            outboxEventPublisher = outboxEventPublisher,
            metrics = OutboxMetrics(metrics, clock),
            clock = clock,
            properties = properties,
        )
}
