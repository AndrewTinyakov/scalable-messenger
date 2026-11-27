package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.ExecutionException
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

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
