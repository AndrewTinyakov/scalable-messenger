package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Completes the rooms of one publication batch with as few commits as possible, without making a finished room wait
 * for a slow one. Whichever room finishes while no completion is running commits everything finished so far; rooms
 * that finish meanwhile join the next commit. If a shared commit fails, each room retries alone, so one room's lost
 * lease never retains another room's events.
 */
internal class GroupCompletion(
    private val commit: (Collection<EventId>) -> Unit,
) {
    private val lock = ReentrantLock()
    private val waiting = ConcurrentLinkedQueue<Request>()

    private class Request(
        val ids: List<EventId>,
    ) {
        val done = CompletableFuture<Unit>()
    }

    fun complete(ids: List<EventId>) {
        val request = Request(ids)
        waiting.add(request)
        while (!request.done.isDone) {
            lock.withLock { if (!request.done.isDone) completeWaiting() }
        }
        try {
            request.done.get()
        } catch (error: ExecutionException) {
            throw error.cause ?: error
        }
    }

    private fun completeWaiting() {
        val requests = generateSequence { waiting.poll() }.toList()
        if (requests.isEmpty()) return
        try {
            commit(requests.flatMap { it.ids })
            requests.forEach { it.done.complete(Unit) }
        } catch (error: Throwable) {
            // Every polled request must settle here, or its caller would wait forever.
            if (requests.size == 1) {
                requests.single().done.completeExceptionally(error)
                return
            }
            for (request in requests) {
                try {
                    commit(request.ids)
                    request.done.complete(Unit)
                } catch (single: Throwable) {
                    request.done.completeExceptionally(single)
                }
            }
        }
    }
}
