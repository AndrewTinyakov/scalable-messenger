package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxEventPublisher
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.PublisherProperties
import jakarta.annotation.PreDestroy
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.stereotype.Component
import reactor.core.scheduler.Schedulers
import tools.jackson.databind.ObjectMapper

@Component
class RoomEventPublisher(
    redis: ReactiveStringRedisTemplate,
    properties: RedisRoomProperties,
    private val publisherProperties: PublisherProperties,
    mapper: ObjectMapper,
    private val publicationHydration: PublicationHydration,
) : OutboxEventPublisher,
    AutoCloseable {
    private val scheduler = Schedulers.newBoundedElastic(
        publisherProperties.concurrency,
        publisherProperties.roomPublicationQueueCapacity,
        "room-publication",
    )
    private val publication = RoomPublicationScript(redis, mapper, properties)

    override fun hydrate(messages: List<OutboxMessage>): List<OutboxMessage> = publicationHydration.prepare(messages)

    override fun publish(message: OutboxMessage) {
        SendStageRecorder.record(SendStage.REDIS_PUBLISH_STARTED, eventId = message.id.value)
        try {
            val streamId = publication.publish(message)
                .subscribeOn(scheduler)
                .timeout(publisherProperties.publishTimeout)
                .block()
            check(streamId != null) { "Redis returned no stream ID" }
            SendStageRecorder.record(SendStage.REDIS_PUBLISH_CONFIRMED, eventId = message.id.value)
        } catch (error: Exception) {
            SendStageRecorder.record(SendStage.REDIS_PUBLISH_FAILED, eventId = message.id.value)
            throw error
        }
    }

    @PreDestroy
    override fun close() {
        scheduler.disposeGracefully().block()
    }
}
