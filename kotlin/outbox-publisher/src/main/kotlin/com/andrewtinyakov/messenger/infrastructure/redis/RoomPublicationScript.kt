package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
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
            listOf(message.payload, mapper.writeValueAsString(options)),
        ).single().doOnNext { check(streamIdPattern.matches(it)) { "Redis returned an invalid stream ID" } }
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
