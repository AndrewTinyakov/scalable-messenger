package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.script.DefaultRedisScript
import org.springframework.stereotype.Component
import java.util.UUID

@Component
class RoomEventPublisher(
    private val redis: StringRedisTemplate,
    private val properties: RedisRoomProperties,
) {
    private val publishScript = DefaultRedisScript<String>().apply {
        setScriptText(
            """
            local epoch = redis.call('GET', KEYS[2])
            local previousStreamId = ''
            if not epoch or redis.call('EXISTS', KEYS[1]) == 0 then
              epoch = ARGV[2]
              redis.call('SET', KEYS[2], epoch)
            else
              local previous = redis.call('XREVRANGE', KEYS[1], '+', '-', 'COUNT', 1)
              if #previous > 0 then previousStreamId = previous[1][1] end
            end
            local streamId = redis.call('XADD', KEYS[1], 'MAXLEN', '~', ARGV[3], '*', 'event', ARGV[1])
            redis.call('EXPIRE', KEYS[1], ARGV[4])
            redis.call('EXPIRE', KEYS[2], ARGV[4])
            local envelope = cjson.encode({epoch=epoch, streamId=streamId, previousStreamId=previousStreamId, event=cjson.decode(ARGV[1])})
            redis.call('SPUBLISH', KEYS[3], envelope)
            return streamId
            """.trimIndent(),
        )
        resultType = String::class.java
    }

    fun publish(message: OutboxMessage) {
        val slot = "{${message.room}}"
        val keys = listOf("messenger:$slot:stream", "messenger:$slot:epoch", "messenger:$slot:live")
        val streamId = redis.execute(
            publishScript,
            keys,
            message.payload,
            UUID.randomUUID().toString(),
            properties.historyMaxLength.toString(),
            properties.idleTtlSeconds.toString(),
        )
        check(streamId != null) { "Redis returned no stream ID" }
    }
}
