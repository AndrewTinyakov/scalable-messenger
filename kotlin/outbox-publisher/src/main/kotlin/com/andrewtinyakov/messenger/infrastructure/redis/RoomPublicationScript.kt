package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.generated.messaging.event.SidebarActivityEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import org.springframework.core.io.ClassPathResource
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.data.redis.core.script.DefaultRedisScript
import reactor.core.publisher.Mono
import tools.jackson.databind.ObjectMapper
import java.util.UUID

private const val MAX_ROOM_LENGTH = 96

internal class RoomPublicationScript(
    private val redis: ReactiveStringRedisTemplate,
    private val mapper: ObjectMapper,
    private val properties: RedisRoomProperties,
) {
    private val script = DefaultRedisScript<String>().apply {
        setLocation(ClassPathResource("redis/publish-room-event.lua"))
        resultType = String::class.java
    }
    private val activityScript = DefaultRedisScript<Long>("return redis.call('SPUBLISH',KEYS[1],ARGV[1])", Long::class.java)
    private val streamIdPattern = Regex("[0-9]+-[0-9]+")

    fun publish(message: OutboxMessage): Mono<String> {
        require(message.room.length <= MAX_ROOM_LENGTH && message.room.none { it.isWhitespace() || it == '{' || it == '}' })
        return appendAndPublish(message, publicationOptions(message)).flatMap { streamId ->
            publishSidebarActivity(message).thenReturn(streamId)
        }
    }

    private fun publicationOptions(message: OutboxMessage) = RoomPublicationOptions(
        version = 1,
        room = message.room,
        eventId = message.id.value,
        epoch = UUID.randomUUID(),
        historyMaxLength = properties.historyMaxLength,
        historyMaxBytes = properties.historyMaxBytes,
        historySeconds = properties.historySeconds,
        idleTtlSeconds = properties.idleTtlSeconds,
        groupPublicationOrder = message.groupPublicationOrder?.also { require(it > 0) }?.toString(),
    )

    private fun appendAndPublish(message: OutboxMessage, options: RoomPublicationOptions): Mono<String> {
        val prefix = "messenger:{${message.room}}"
        return redis.execute(
            script,
            listOf("$prefix:stream", "$prefix:epoch", "$prefix:live", "$prefix:history-bytes"),
            listOf(message.payload, mapper.writeValueAsString(options), message.replayPayload ?: message.payload),
        ).single().doOnNext { check(streamIdPattern.matches(it)) { "Redis returned an invalid stream ID" } }
    }

    private fun publishSidebarActivity(message: OutboxMessage): Mono<Long> {
        val activity = sidebarActivity(message) ?: return Mono.empty()
        return redis.execute(
            activityScript,
            listOf("messenger:{activity:${activity.chatId}}:live"),
            listOf(mapper.writeValueAsString(activity)),
        ).single()
    }

    private fun sidebarActivity(message: OutboxMessage): SidebarActivityEventV1? {
        val event = mapper.readTree(message.payload)
        if (!RoomAddress.isGroup(message.room) || event.path("type").asText() != RoomEventType.MESSAGE_SAVED.value) return null
        return SidebarActivityEventV1.create(event.path("chatId").asText(), event.path("sequence").asText())
    }
}
