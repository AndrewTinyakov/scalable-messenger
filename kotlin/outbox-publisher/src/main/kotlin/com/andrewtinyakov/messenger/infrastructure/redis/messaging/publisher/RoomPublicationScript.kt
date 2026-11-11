package com.andrewtinyakov.messenger.infrastructure.redis.messaging.publisher

import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.generated.messaging.event.SidebarActivityEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.infrastructure.redis.config.RedisRoomProperties
import org.springframework.core.io.ClassPathResource
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.data.redis.core.script.DefaultRedisScript
import reactor.core.publisher.Mono
import tools.jackson.databind.ObjectMapper
import java.util.UUID

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
        require(message.room.length <= 96 && message.room.none { it.isWhitespace() || it == '{' || it == '}' })
        val prefix = "messenger:{${message.room}}"
        val options = PublicationOptions(
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
        return redis.execute(
            script,
            listOf("$prefix:stream", "$prefix:epoch", "$prefix:live", "$prefix:history-bytes"),
            listOf(message.payload, mapper.writeValueAsString(options), message.replayPayload ?: message.payload),
        ).single().doOnNext { check(streamIdPattern.matches(it)) { "Redis returned an invalid stream ID" } }.flatMap { streamId ->
            val event = mapper.readTree(message.payload)
            if (RoomAddress.isGroup(message.room) && event.path("type").asText() == RoomEventType.MESSAGE_SAVED.value) {
                val chatId = event.path("chatId").asText()
                val hint = mapper.writeValueAsString(SidebarActivityEventV1.create(chatId, event.path("sequence").asText()))
                redis.execute(activityScript, listOf("messenger:{activity:$chatId}:live"), listOf(hint)).single().thenReturn(streamId)
            } else {
                Mono.just(streamId)
            }
        }
    }
}

private data class PublicationOptions(
    val version: Int,
    val room: String,
    val eventId: String,
    val epoch: UUID,
    val historyMaxLength: Int,
    val historyMaxBytes: Int,
    val historySeconds: Int,
    val idleTtlSeconds: Int,
    val groupPublicationOrder: String?,
)
