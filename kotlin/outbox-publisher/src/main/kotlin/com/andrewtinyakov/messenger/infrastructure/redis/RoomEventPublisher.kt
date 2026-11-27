package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStage
import com.andrewtinyakov.messenger.infrastructure.monitoring.SendStageRecorder
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublisherProperties
import com.andrewtinyakov.messenger.infrastructure.outbox.publication.OutboxEventPublisher
import jakarta.annotation.PreDestroy
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.stereotype.Component
import reactor.core.scheduler.Schedulers
import tools.jackson.databind.ObjectMapper

@Component
class RoomEventPublisher(
    redis: ReactiveStringRedisTemplate,
    properties: RedisRoomProperties,
    private val outboxPublisherProperties: OutboxPublisherProperties,
    mapper: ObjectMapper,
    private val publicationHydration: PublicationHydration,
    chatRepository: ChatRepository,
    presenceRedis: PresenceRedis,
) : OutboxEventPublisher,
    AutoCloseable {
    private val scheduler = Schedulers.newBoundedElastic(
        outboxPublisherProperties.concurrency,
        outboxPublisherProperties.roomPublicationQueueCapacity,
        "room-publication",
    )
    private val publication = RoomPublicationScript(redis, presenceRedis.template, mapper, properties) { chatId ->
        chatRepository.findMemberIds(ChatId(chatId)).map(UserId::value)
    }

    override fun hydrate(messages: List<OutboxMessage>): List<OutboxMessage> = publicationHydration.prepare(messages)

    override fun publish(message: OutboxMessage) {
        SendStageRecorder.record(SendStage.REDIS_PUBLISH_STARTED, eventId = message.id.value)
        try {
            val streamId = publication.publish(message)
                .subscribeOn(scheduler)
                .timeout(outboxPublisherProperties.publishTimeout)
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
