package com.andrewtinyakov.messenger.infrastructure.outbox.publication

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import java.util.concurrent.CompletableFuture

internal class GroupCompletionRequest(
    val ids: List<EventId>,
) {
    val done = CompletableFuture<Unit>()
}
