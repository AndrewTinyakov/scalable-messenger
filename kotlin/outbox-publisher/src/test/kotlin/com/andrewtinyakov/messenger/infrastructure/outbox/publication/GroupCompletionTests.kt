package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

class GroupCompletionTests {
    @Test
    fun `rooms that finish during a commit share the next one`() {
        val commits = ConcurrentLinkedQueue<Set<EventId>>()
        val firstStarted = CountDownLatch(1)
        val release = CountDownLatch(1)
        val completion = GroupCompletion { ids ->
            commits.add(ids.toSet())
            if (commits.size == 1) {
                firstStarted.countDown()
                check(release.await(5, TimeUnit.SECONDS))
            }
        }
        val rooms = List(4) { listOf(EventId(newId())) }
        Executors.newVirtualThreadPerTaskExecutor().use { executor ->
            val first = executor.submit { completion.complete(rooms[0]) }
            assertTrue(firstStarted.await(2, TimeUnit.SECONDS))
            val others = rooms.drop(1).map { room -> executor.submit { completion.complete(room) } }
            Thread.sleep(100)
            release.countDown()
            (listOf(first) + others).forEach { it.get(5, TimeUnit.SECONDS) }
        }
        assertEquals(listOf(rooms[0].toSet(), rooms.drop(1).flatten().toSet()), commits.toList())
    }

    @Test
    fun `a failed shared commit retries each room alone`() {
        val lost = EventId(newId())
        val healthy = EventId(newId())
        val blockerId = EventId(newId())
        val committed = ConcurrentLinkedQueue<EventId>()
        val blocker = CountDownLatch(1)
        val blocked = CountDownLatch(1)
        val completion = GroupCompletion { ids ->
            if (ids == listOf(blockerId)) {
                blocked.countDown()
                check(blocker.await(5, TimeUnit.SECONDS))
                return@GroupCompletion
            }
            check(lost !in ids) { "Lease lost" }
            committed.addAll(ids)
        }
        val first = CompletableFuture.runAsync { completion.complete(listOf(blockerId)) }
        assertTrue(blocked.await(2, TimeUnit.SECONDS))
        val failing = CompletableFuture.runAsync { completion.complete(listOf(lost)) }
        val succeeding = CompletableFuture.runAsync { completion.complete(listOf(healthy)) }
        Thread.sleep(100)
        blocker.countDown()
        first.get(5, TimeUnit.SECONDS)
        succeeding.get(5, TimeUnit.SECONDS)
        assertThrows(Exception::class.java) { failing.get(5, TimeUnit.SECONDS) }
        assertEquals(listOf(healthy), committed.toList())
    }
}
