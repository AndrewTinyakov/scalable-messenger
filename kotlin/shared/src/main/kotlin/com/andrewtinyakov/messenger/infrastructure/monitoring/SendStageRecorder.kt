package com.andrewtinyakov.messenger.infrastructure.monitoring

import jdk.jfr.EventType

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
