package com.andrewtinyakov.messenger.outbox

import com.andrewtinyakov.messenger.messaging.RoomEventV1
import com.fasterxml.jackson.databind.ObjectMapper
import org.springframework.beans.factory.annotation.Value
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty
import org.springframework.data.redis.core.StringRedisTemplate
import org.springframework.data.redis.core.script.DefaultRedisScript
import org.springframework.scheduling.annotation.Scheduled
import org.springframework.stereotype.Component
import org.springframework.transaction.support.TransactionTemplate
import java.time.Clock
import java.time.OffsetDateTime
import java.util.UUID

data class PendingEvent(
    val id: String,
    val room: String,
    val payload: String,
)

@Component
@ConditionalOnProperty(name = ["messenger.role"], havingValue = "relay")
class OutboxRelay(
    private val repository: OutboxRepository,
    private val tx: TransactionTemplate,
    private val redis: StringRedisTemplate,
    private val mapper: ObjectMapper,
    private val clock: Clock,
    @Value("\${messenger.relay.batch-size:50}") private val batchSize: Int,
    @Value("\${messenger.relay.lease-seconds:30}") private val leaseSeconds: Long,
) {
    private val owner = UUID.randomUUID().toString()
    private val log = org.slf4j.LoggerFactory.getLogger(javaClass)

    // All keys share {room}, so this script also works with Redis Cluster.
    private val publishScript = DefaultRedisScript<String>().apply {
        setScriptText(
            """
            local epoch = redis.call('GET', KEYS[2])
            if not epoch or redis.call('EXISTS', KEYS[1]) == 0 then
              epoch = ARGV[2]
              redis.call('SET', KEYS[2], epoch)
            end
            local streamId = redis.call('XADD', KEYS[1], 'MAXLEN', '~', '1000', '*', 'event', ARGV[1])
            local envelope = cjson.encode({epoch=epoch, streamId=streamId, event=cjson.decode(ARGV[1])})
            redis.call('SPUBLISH', KEYS[3], envelope)
            return streamId
            """.trimIndent(),
        )
        resultType = String::class.java
    }

    @Scheduled(fixedDelayString = "\${messenger.relay.delay-ms:1000}")
    fun publishPending() {
        require(batchSize in 1..500)
        require(leaseSeconds in 5..300)
        val rows = claim()
        for (row in rows) {
            try {
                val event = mapper.readValue(row.payload, RoomEventV1::class.java)
                require(event.eventId == row.id && event.room == row.room)
                publish(row)
                check(repository.complete(row.id, owner, OffsetDateTime.now(clock)))
            } catch (error: Exception) {
                log.error("Outbox publication failed for event {}", row.id, error)
            }
        }
    }

    private fun claim(): List<PendingEvent> = tx.execute {
        val now = OffsetDateTime.now(clock)
        repository.claim(now, batchSize, owner, now.plusSeconds(leaseSeconds))
    } ?: emptyList()

    private fun publish(row: PendingEvent) {
        val slot = "{${row.room}}"
        val keys = listOf("messenger:$slot:stream", "messenger:$slot:epoch", "messenger:$slot:live")
        val streamId = redis.execute(publishScript, keys, row.payload, UUID.randomUUID().toString())
        check(streamId != null) { "Redis returned no stream ID" }
    }
}
