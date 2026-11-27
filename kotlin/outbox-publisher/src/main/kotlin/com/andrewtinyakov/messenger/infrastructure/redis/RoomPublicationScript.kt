package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.generated.messaging.event.SidebarActivityEventV1
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import org.springframework.core.io.ClassPathResource
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.data.redis.core.script.DefaultRedisScript
import reactor.core.publisher.Flux
import reactor.core.publisher.Mono
import tools.jackson.databind.ObjectMapper
import java.util.UUID

private const val MAX_ROOM_LENGTH = 96
private const val MAX_REVOKED_PER_MESSAGE = 500

internal class RoomPublicationScript(
    private val redis: ReactiveStringRedisTemplate,
    private val mapper: ObjectMapper,
    private val properties: RedisRoomProperties,
    private val groupMembers: (chatId: String) -> List<String>,
) {
    private val script = DefaultRedisScript<String>().apply {
        setLocation(ClassPathResource("redis/publish-room-event.lua"))
        resultType = String::class.java
    }
    private val livePublishScript = DefaultRedisScript<Long>("return redis.call('SPUBLISH',KEYS[1],ARGV[1])", Long::class.java)
    private val streamIdPattern = Regex("[0-9]+-[0-9]+")

    fun publish(message: OutboxMessage): Mono<String> {
        require(message.room.length <= MAX_ROOM_LENGTH && message.room.none { it.isWhitespace() || it == '{' || it == '}' })
        return appendAndPublish(message, publicationOptions(message)).flatMap { streamId ->
            publishSidebarActivity(message).then(publishPresenceRevocation(message)).thenReturn(streamId)
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

    // Activity is pub/sub only: it never enters the replay stream, so a preview isn't retained after deletion.
    private fun publishSidebarActivity(message: OutboxMessage): Mono<Long> {
        if (!RoomAddress.isGroup(message.room)) return Mono.empty()
        val event = mapper.readTree(message.payload)
        if (event.path("type").asText() != RoomEventType.MESSAGE_SAVED.value) return Mono.empty()
        val chatId = event.path("chatId").asText()
        val activity = message.activityPayload
            ?: mapper.writeValueAsString(SidebarActivityEventV1.create(chatId, event.path("sequence").asText()))
        return redis.execute(livePublishScript, listOf("messenger:{activity:$chatId}:live"), listOf(activity)).single()
    }

    // A removal or group deletion can end who may see whose presence. Gateways that watch the affected users
    // check those grants again; grant expiry covers a lost message. One copy of each event triggers it: the
    // removed member's user room, or the deleted group's room.
    private fun publishPresenceRevocation(message: OutboxMessage): Mono<Void> = Mono.defer {
        val event = mapper.readTree(message.payload)
        val type = event.path("type").asText()
        val users = when {
            type == RoomEventType.MEMBER_REMOVED.value && !RoomAddress.isGroup(message.room) -> listOf(event.path("memberId").asText())
            type == RoomEventType.CHAT_DELETED.value && RoomAddress.isGroup(message.room) -> groupMembers(event.path("chatId").asText())
            else -> emptyList()
        }
        Flux.fromIterable(users.groupBy(PresenceBuckets::of).entries)
            .concatMapIterable { (bucket, ids) -> ids.chunked(MAX_REVOKED_PER_MESSAGE).map { bucket to it } }
            .concatMap { (bucket, ids) ->
                redis.execute(
                    livePublishScript,
                    listOf(PresenceBuckets.channel(bucket)),
                    listOf(mapper.writeValueAsString(mapOf("r" to ids))),
                )
            }
            .then()
    }
}
