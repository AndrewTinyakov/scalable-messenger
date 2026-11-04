package com.andrewtinyakov.messenger.infrastructure.monitoring

import jdk.jfr.Enabled
import jdk.jfr.Event
import jdk.jfr.EventType
import jdk.jfr.Name
import jdk.jfr.StackTrace

enum class SendStage {
    LISTENER_RECEIVED,
    REQUEST_LOCKS_ACQUIRED,
    RESULTS_LOOKED_UP,
    CHAT_LOCKED,
    MEMBERSHIP_CHECKED,
    SEQUENCES_ALLOCATED,
    MESSAGES_RESULTS_WRITTEN,
    OUTBOX_WRITTEN,
    TRANSACTION_CALLBACK_FINISHED,
    TRANSACTION_COMMITTED,
    TRANSACTION_ROLLED_BACK,
    TRANSACTION_UNKNOWN,
    EVENT_PREPARED,
    OUTBOX_CLAIM_COMMITTED,
    REDIS_PUBLISH_STARTED,
    REDIS_PUBLISH_CONFIRMED,
    REDIS_PUBLISH_FAILED,
    ;

    val value = name.lowercase()
}

@Name("messenger.SendStage")
@Enabled(false)
@StackTrace(false)
class SendStageEvent : Event() {
    @JvmField
    var stage: String = ""

    @JvmField
    var requestId: String? = null

    @JvmField
    var eventId: String? = null
}

object SendStageRecorder {
    private val type = probe<EventType?>(null) { EventType.getEventType(SendStageEvent::class.java) }

    val isEnabled: Boolean
        get() = probe(false) { type?.isEnabled == true }

    fun record(stage: SendStage, requestId: String? = null, eventId: String? = null) {
        if (!isEnabled) return
        probe(Unit) {
            SendStageEvent().apply {
                this.stage = stage.value
                this.requestId = requestId
                this.eventId = eventId
                commit()
            }
        }
    }

    fun <T> requests(stage: SendStage, values: Iterable<T>, requestId: (T) -> String) {
        if (!isEnabled) return
        probe(Unit) { values.forEach { record(stage, requestId = requestId(it)) } }
    }

    fun <T, K> beginEach(stage: SendStage, values: Iterable<T>, key: (T) -> K): Map<K, SendStageEvent?> {
        if (!isEnabled) return emptyMap()
        return probe(emptyMap()) { values.associate { key(it) to begin(stage) } }
    }

    fun commit(event: SendStageEvent?, requestId: String) {
        if (event == null) return
        probe(Unit) {
            event.requestId = requestId
            event.end()
            event.commit()
        }
    }

    private fun begin(stage: SendStage): SendStageEvent? = probe(null) {
        SendStageEvent().apply {
            this.stage = stage.value
            begin()
        }
    }

    private inline fun <T> probe(fallback: T, action: () -> T): T = try {
        action()
    } catch (_: RuntimeException) {
        fallback
    } catch (_: LinkageError) {
        fallback
    }
}
