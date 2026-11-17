package com.andrewtinyakov.messenger.infrastructure.redis

import com.andrewtinyakov.messenger.infrastructure.outbox.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.MemoryOutbox
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxMetrics
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublicationService
import com.andrewtinyakov.messenger.infrastructure.outbox.PublisherProperties
import com.andrewtinyakov.messenger.infrastructure.outbox.outboxEvent
import com.andrewtinyakov.messenger.infrastructure.outbox.outboxTransactions
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.shared.id.newId
import io.lettuce.core.RedisClient
import io.lettuce.core.pubsub.RedisPubSubAdapter
import io.micrometer.core.instrument.simple.SimpleMeterRegistry
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Assumptions.assumeTrue
import org.junit.jupiter.api.Test
import org.mockito.Mockito.mock
import org.springframework.data.domain.Range
import org.springframework.data.redis.connection.ReactiveRedisConnection
import org.springframework.data.redis.connection.ReactiveRedisConnectionFactory
import org.springframework.data.redis.connection.RedisStandaloneConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceClientConfiguration
import org.springframework.data.redis.connection.lettuce.LettuceConnectionFactory
import org.springframework.data.redis.core.ReactiveStringRedisTemplate
import org.springframework.data.redis.core.StringRedisTemplate
import tools.jackson.databind.json.JsonMapper
import tools.jackson.databind.node.ObjectNode
import java.net.URI
import java.nio.file.Path
import java.time.Clock
import java.time.Duration
import java.util.concurrent.CountDownLatch
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.io.path.readText

class RoomEventPublisherIntegrationTests {
    private val publishers = mutableListOf<RoomEventPublisher>()

    @Test
    fun `group publication emits the shared bodyless sidebar activity fixture without retained content`() {
        withRedis { factory ->
            val mapper = JsonMapper.builder().build()
            val expected = mapper.readTree(Path.of("../../contracts/fixtures/valid/sidebar-activity.json").readText())
            val event = mapper.readTree(Path.of("../../contracts/fixtures/valid/message-saved.json").readText()) as ObjectNode
            val chatId = expected.path("chatId").asText()
            val room = "group:$chatId"
            val eventId = newId()
            event.put("room", room).put("eventId", eventId)
            val replay = mapper.writeValueAsString(
                mapOf(
                    "type" to "history_changed",
                    "version" to 1,
                    "eventId" to eventId,
                    "room" to room,
                    "chatId" to chatId,
                    "sequence" to expected.path("sequence").asText(),
                    "mutationRevision" to "0",
                    "visibilityRevision" to "0",
                ),
            )
            withLiveMessages(factory, "activity:$chatId") { received ->
                roomPublisher(
                    ReactiveStringRedisTemplate(factory),
                ).publish(OutboxMessage(EventId(eventId), room, mapper.writeValueAsString(event), replayPayload = replay))
                val actual = received.poll(1, TimeUnit.SECONDS)
                assertTrue(actual != null)
                assertEquals(expected, mapper.readTree(actual!!))
                assertEquals(false, StringRedisTemplate(factory).hasKey("messenger:{activity:$chatId}:stream"))
            }
        }
    }

    @Test
    fun `body-bearing replay is rejected before retained history changes`() {
        withRedis { factory ->
            val row = outboxEvent().let { it.copy(payload = it.payload.dropLast(1) + ",\"body\":\"content\"}") }
            val failure = assertThrows(RuntimeException::class.java) {
                roomPublisher(ReactiveStringRedisTemplate(factory)).publish(row)
            }
            assertTrue(
                generateSequence<Throwable>(failure) {
                    it.cause
                }.any { it.message?.contains("replay content is forbidden") == true },
            )
            assertEquals(false, StringRedisTemplate(factory).hasKey("messenger:{${row.room}}:stream"))
        }
    }

    @Test
    fun `live content is published while replay retains only recovery metadata`() {
        withRedis { factory ->
            val room = "group:${newId()}"
            val mapper = JsonMapper.builder().build()
            val id = newId()
            val hint = """{"type":"history_changed","version":1,"eventId":"$id","room":"$room","chatId":"${room.removePrefix(
                "group:",
            )}","sequence":"9","mutationRevision":"0","visibilityRevision":"0"}"""
            val live = """{"type":"message_saved","eventId":"$id","room":"$room","body":"ephemeral message content"}"""
            val row = OutboxMessage(EventId(id), room, live, replayPayload = hint)
            val publisher = roomPublisher(ReactiveStringRedisTemplate(factory))
            withLiveMessages(factory, room) { received ->
                publisher.publish(row)
                val envelope = mapper.readValue(received.poll(2, TimeUnit.SECONDS), Map::class.java)
                assertEquals("ephemeral message content", (envelope["event"] as Map<*, *>)["body"])
            }
            val retained = StringRedisTemplate(factory).opsForStream<String, String>()
                .range("messenger:{$room}:stream", Range.unbounded())!!
            assertEquals(listOf(hint), retained.map { it.value["event"] })
            assertEquals(
                hint.toByteArray().size.toString(),
                StringRedisTemplate(factory).opsForValue().get("messenger:{$room}:history-bytes"),
            )
        }
    }

    @Test
    fun `busy rooms retain a useful reconnect window beyond one thousand events`() {
        withRedis { factory ->
            val room = "group:test-${newId()}"
            val publisher = roomPublisher(ReactiveStringRedisTemplate(factory))
            repeat(1100) { publisher.publish(outboxEvent(room)) }
            val history = StringRedisTemplate(factory).opsForStream<String, String>()
            assertEquals(1100L, history.size("messenger:{$room}:stream"))
        }
    }

    @Test
    fun `history obeys payload bytes count and time bounds while publishing the latest event`() {
        withRedis { factory ->
            val redis = StringRedisTemplate(factory)
            val room = "group:test-${newId()}"
            val publisher = roomPublisher(
                ReactiveStringRedisTemplate(factory),
                properties = RedisRoomProperties(historyMaxLength = 3, historyMaxBytes = 65536, historySeconds = 1),
            )
            val rows = List(6) {
                val row = outboxEvent(room)
                row.copy(payload = row.payload.dropLast(1) + ",\"padding\":\"${"x".repeat(22000)}\"}")
            }
            rows.forEach(publisher::publish)
            val key = "messenger:{$room}:stream"
            val retained = redis.opsForStream<String, String>().range(key, Range.unbounded())!!
            assertEquals(rows.takeLast(2).map { it.payload }, retained.map { it.value["event"] })
            assertTrue(retained.sumOf { it.value.getValue("event").toByteArray().size } <= 65536)
            assertEquals(
                retained.sumOf { it.value.getValue("event").toByteArray().size }.toString(),
                redis.opsForValue().get("messenger:{$room}:history-bytes"),
            )
            val small = List(6) { outboxEvent(room) }
            small.forEach(publisher::publish)
            assertEquals(
                small.takeLast(3).map {
                    it.payload
                },
                redis.opsForStream<String, String>().range(key, Range.unbounded())!!.map { it.value["event"] },
            )
            Thread.sleep(1100)
            val latest = outboxEvent(room)
            publisher.publish(latest)
            assertEquals(
                listOf(latest.payload),
                redis.opsForStream<String, String>().range(key, Range.unbounded())!!.map {
                    it.value["event"]
                },
            )
            assertTrue(redis.getExpire("messenger:{$room}:history-bytes") in 1L..3600L)
        }
    }

    @Test
    fun `late group publications cannot append behind a newer prefix`() {
        withRedis { factory ->
            val room = "group:test-${newId()}"
            val rows = List(3) { outboxEvent(room).copy(groupPublicationOrder = 9007199254740993L + it) }
            val publisher = roomPublisher(ReactiveStringRedisTemplate(factory))
            val mapper = JsonMapper.builder().build()
            withLiveMessages(factory, room) { messages ->
                rows.forEach {
                    publisher.publish(it)
                    assertEquals(
                        it.id.value,
                        mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS))).path("event").path("eventId").stringValue(),
                    )
                }
                publisher.publish(rows[0])
                publisher.publish(rows[1])
                assertEquals(null, messages.poll(200, TimeUnit.MILLISECONDS))
                val last = outboxEvent(room).copy(groupPublicationOrder = Long.MAX_VALUE)
                publisher.publish(last)
                assertEquals(
                    last.id.value,
                    mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS))).path("event").path("eventId").stringValue(),
                )
                val history = StringRedisTemplate(
                    factory,
                ).opsForStream<String, String>().range("messenger:{$room}:stream", Range.unbounded())!!
                assertEquals((rows + last).map { it.payload }, history.map { it.value["event"] })
            }
        }
    }

    @Test
    fun `shared fixtures preserve live types and bodyless replay types`() {
        withRedis { factory ->
            val redis = StringRedisTemplate(factory)
            val mapper = JsonMapper.builder().build()
            val publisher = roomPublisher(ReactiveStringRedisTemplate(factory))
            val fixtures =
                listOf("chat-created", "member-removed", "membership-changed", "message-saved", "send-rejected", "session-revoked")
            for (name in fixtures) {
                val event = mapper.readTree(Path.of("../../contracts/fixtures/valid/$name.json").readText()) as ObjectNode
                val room = "${event.path("room").stringValue().substringBefore(':')}:${newId()}"
                event.put("room", room)
                val payload = mapper.writeValueAsString(event)
                val replay = if (event.path("type").stringValue() == "message_saved") {
                    mapper.writeValueAsString(
                        mapOf(
                            "type" to "history_changed",
                            "version" to 1,
                            "eventId" to event.path("eventId").stringValue(),
                            "room" to room,
                            "chatId" to event.path("chatId").stringValue(),
                            "sequence" to event.path("sequence").stringValue(),
                            "mutationRevision" to "0",
                            "visibilityRevision" to "0",
                        ),
                    )
                } else {
                    payload
                }
                val message = OutboxMessage(EventId(event.path("eventId").stringValue()), room, payload, replayPayload = replay)

                withLiveMessages(factory, room) { messages ->
                    publisher.publish(message)

                    val envelope = mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS)))
                    val history = redis.opsForStream<String, String>().range("messenger:{$room}:stream", Range.unbounded())!!
                    assertEquals(event, envelope.path("event"), name)
                    assertEquals(listOf(replay), history.map { it.value["event"] }, name)
                    assertEquals(history.single().id.value, envelope.path("streamId").stringValue(), name)
                    assertEquals(redis.opsForValue().get("messenger:{$room}:epoch"), envelope.path("epoch").stringValue(), name)
                    assertEquals("", envelope.path("previousStreamId").stringValue(), name)
                    assertTrue(redis.getExpire("messenger:{$room}:stream") in 1L..3600L)
                    assertTrue(redis.getExpire("messenger:{$room}:epoch") in 1L..3600L)
                }
            }
        }
    }

    @Test
    fun `script cache loss preserves continuity and missing history starts a new epoch`() {
        withRedis { factory ->
            val room = "user:test-${newId()}"
            val redis = StringRedisTemplate(factory)
            val mapper = JsonMapper.builder().build()
            val publisher = roomPublisher(ReactiveStringRedisTemplate(factory))

            withLiveMessages(factory, room) { messages ->
                publisher.publish(outboxEvent(room))
                val first = mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS)))

                factory.connection.use { it.scriptingCommands().scriptFlush() }
                publisher.publish(outboxEvent(room))
                val second = mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS)))

                assertEquals(first.path("epoch"), second.path("epoch"))
                assertEquals(first.path("streamId"), second.path("previousStreamId"))

                redis.delete("messenger:{$room}:history-bytes")
                publisher.publish(outboxEvent(room))
                val migrated = mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS)))
                assertTrue(migrated.path("epoch") != second.path("epoch"))
                assertEquals("", migrated.path("previousStreamId").stringValue())
                assertEquals(1L, redis.opsForStream<String, String>().size("messenger:{$room}:stream"))

                redis.delete("messenger:{$room}:stream")
                publisher.publish(outboxEvent(room))
                val reset = mapper.readTree(checkNotNull(messages.poll(3, TimeUnit.SECONDS)))

                assertTrue(reset.path("epoch") != second.path("epoch"))
                assertEquals("", reset.path("previousStreamId").stringValue())
                assertEquals(redis.opsForValue().get("messenger:{$room}:epoch"), reset.path("epoch").stringValue())
            }
        }
    }

    @Test
    fun `mismatched event identity or room fails before Redis changes`() {
        withRedis { factory ->
            val wrongRoom = outboxEvent().copy(room = "group:test-${newId()}")
            val wrongIdentity = outboxEvent().copy(id = EventId(newId()))
            val rows = listOf(wrongRoom, wrongIdentity)
            val repository = MemoryOutbox(initial = rows)
            val publisher = roomPublisher(redis = ReactiveStringRedisTemplate(factory))
            rows.zip(listOf("event room mismatch", "event identity mismatch")).forEach { (row, reason) ->
                val failure = assertThrows(RuntimeException::class.java) { publisher.publish(row) }
                assertTrue(generateSequence<Throwable>(failure) { it.cause }.any { it.message?.contains(reason) == true })
            }
            val service = OutboxPublicationService(
                outboxClaimRepository = repository,
                tx = outboxTransactions(),
                outboxEventPublisher = publisher,
                metrics = OutboxMetrics(SimpleMeterRegistry(), Clock.systemUTC()),
                clock = Clock.systemUTC(),
                properties = PublisherProperties(),
            )

            assertEquals(0, service.publishBatch())
            assertEquals(rows, repository.remaining())
            val redis = StringRedisTemplate(factory)
            rows.forEach { row ->
                assertEquals(false, redis.hasKey("messenger:{${row.room}}:stream"))
                assertEquals(false, redis.hasKey("messenger:{${row.room}}:epoch"))
            }
        }
    }

    @Test
    fun `independent rooms publish while another room awaits transport capacity`() {
        withRedis { factory ->
            val started = CountDownLatch(2)
            val connections = object : ReactiveRedisConnectionFactory by factory {
                override fun getReactiveConnection(): ReactiveRedisConnection {
                    started.countDown()
                    check(started.await(1, TimeUnit.SECONDS)) { "Independent publication did not start" }
                    return factory.reactiveConnection
                }
            }
            val rows = listOf(outboxEvent(), outboxEvent())
            val repository = MemoryOutbox(initial = rows)
            val publisher = roomPublisher(redis = ReactiveStringRedisTemplate(connections))
            val service = OutboxPublicationService(
                outboxClaimRepository = repository,
                tx = outboxTransactions(),
                outboxEventPublisher = publisher,
                metrics = OutboxMetrics(SimpleMeterRegistry(), Clock.systemUTC()),
                clock = Clock.systemUTC(),
                properties = PublisherProperties(),
            )

            assertEquals(2, service.publishBatch())
            assertEquals(emptyList<OutboxMessage>(), repository.remaining())
            val redis = StringRedisTemplate(factory)
            rows.forEach { row ->
                val history = redis.opsForStream<String, String>().range("messenger:{${row.room}}:stream", Range.unbounded())!!
                assertEquals(listOf(row.payload), history.map { it.value["event"] })
            }
        }
    }

    @Test
    fun `events from one room keep their order while other rooms publish`() {
        withRedis { factory ->
            val room = "user:test-${newId()}"
            val ordered = List(8) { outboxEvent(targetRoom = room) }
            val rows = ordered + List(8) { outboxEvent() }
            val repository = MemoryOutbox(initial = rows)
            val redis = StringRedisTemplate(factory)
            val service = OutboxPublicationService(
                outboxClaimRepository = repository,
                tx = outboxTransactions(),
                outboxEventPublisher = roomPublisher(redis = ReactiveStringRedisTemplate(factory)),
                metrics = OutboxMetrics(SimpleMeterRegistry(), Clock.systemUTC()),
                clock = Clock.systemUTC(),
                properties = PublisherProperties(),
            )

            assertEquals(16, service.publishBatch())
            val history = redis.opsForStream<String, String>().range("messenger:{$room}:stream", Range.unbounded())!!
            assertEquals(ordered.map { it.payload }, history.map { it.value["event"] })
        }
    }

    @Test
    fun `failed publication retains its room events while successful rooms complete`() {
        withRedis { factory ->
            val failed = outboxEvent(targetRoom = "user:test-${newId()}").copy(payload = "{")
            val later = outboxEvent(targetRoom = failed.room)
            val healthy = outboxEvent()
            val repository = MemoryOutbox(initial = listOf(failed, later, healthy))
            val redis = StringRedisTemplate(factory)
            val service = OutboxPublicationService(
                outboxClaimRepository = repository,
                tx = outboxTransactions(),
                outboxEventPublisher = roomPublisher(redis = ReactiveStringRedisTemplate(factory)),
                metrics = OutboxMetrics(SimpleMeterRegistry(), Clock.systemUTC()),
                clock = Clock.systemUTC(),
                properties = PublisherProperties(),
            )

            assertEquals(1, service.publishBatch())
            assertEquals(listOf(failed, later), repository.remaining())
            assertEquals(false, redis.hasKey("messenger:{${failed.room}}:stream"))
        }
    }

    @Test
    fun `publication claim fits its configured event byte budget`() {
        withRedis { factory ->
            val rows = listOf(outboxEvent(), outboxEvent())
            val repository = MemoryOutbox(initial = rows)
            val service = OutboxPublicationService(
                outboxClaimRepository = repository,
                tx = outboxTransactions(),
                outboxEventPublisher = roomPublisher(redis = ReactiveStringRedisTemplate(factory)),
                metrics = OutboxMetrics(SimpleMeterRegistry(), Clock.systemUTC()),
                clock = Clock.systemUTC(),
                properties = PublisherProperties(batchBytes = 65536),
            )

            assertEquals(1, service.publishBatch())
            assertEquals(listOf(rows[1]), repository.remaining())
            assertEquals(1, service.publishBatch())
            assertEquals(emptyList<OutboxMessage>(), repository.remaining())
        }
    }

    @Test
    fun `publication deadline covers connection acquisition without publishing after cancellation`() {
        withRedis { factory ->
            val started = CountDownLatch(1)
            val release = CountDownLatch(1)
            val acquired = CountDownLatch(1)
            val connections = object : ReactiveRedisConnectionFactory by factory {
                override fun getReactiveConnection(): ReactiveRedisConnection {
                    started.countDown()
                    val deadline = System.nanoTime() + TimeUnit.SECONDS.toNanos(2)
                    while (release.count > 0) {
                        try {
                            check(release.await(deadline - System.nanoTime(), TimeUnit.NANOSECONDS)) {
                                "Connection acquisition was not released"
                            }
                        } catch (_: InterruptedException) {
                            continue
                        }
                    }
                    return factory.reactiveConnection.also { acquired.countDown() }
                }
            }
            val row = outboxEvent()
            val repository = MemoryOutbox(initial = listOf(row))
            val publisher = roomPublisher(redis = ReactiveStringRedisTemplate(connections), timeout = Duration.ofMillis(100))
            val service = OutboxPublicationService(
                outboxClaimRepository = repository,
                tx = outboxTransactions(),
                outboxEventPublisher = publisher,
                metrics = OutboxMetrics(SimpleMeterRegistry(), Clock.systemUTC()),
                clock = Clock.systemUTC(),
                properties = PublisherProperties(lease = Duration.ofSeconds(5), publishTimeout = Duration.ofMillis(100)),
            )

            val before = System.nanoTime()
            try {
                assertEquals(0, service.publishBatch())
                assertTrue(System.nanoTime() - before < TimeUnit.MILLISECONDS.toNanos(750))
                assertTrue(started.await(1, TimeUnit.SECONDS))
                assertEquals(listOf(row), repository.remaining())
            } finally {
                release.countDown()
                publisher.close()
                publishers.remove(publisher)
            }
            assertTrue(acquired.await(1, TimeUnit.SECONDS))
            assertEquals(false, StringRedisTemplate(factory).hasKey("messenger:{${row.room}}:stream"))
        }
    }

    private fun roomPublisher(
        redis: ReactiveStringRedisTemplate,
        timeout: Duration = Duration.ofSeconds(1),
        properties: RedisRoomProperties = RedisRoomProperties(),
    ): RoomEventPublisher =
        RoomEventPublisher(
            redis = redis,
            properties = properties,
            publisherProperties = PublisherProperties(publishTimeout = timeout),
            mapper = JsonMapper.builder().build(),
            publicationHydration = PublicationHydration(
                mock(MessageRepository::class.java),
                JsonMapper.builder().build(),
                PublicationHydrationMetrics(SimpleMeterRegistry()),
            ),
        ).also { publishers.add(it) }

    private fun withLiveMessages(factory: LettuceConnectionFactory, room: String, action: (LinkedBlockingQueue<String>) -> Unit) {
        (factory.nativeClient as RedisClient).connectPubSub().use { connection ->
            val messages = LinkedBlockingQueue<String>()
            connection.addListener(
                object : RedisPubSubAdapter<String, String>() {
                    override fun smessage(shardChannel: String, message: String) {
                        messages.add(message)
                    }
                },
            )
            connection.sync().ssubscribe("messenger:{$room}:live")
            action(messages)
        }
    }

    private fun withRedis(action: (LettuceConnectionFactory) -> Unit) {
        val raw = System.getenv("REDIS_TEST_URL")
        assumeTrue(!raw.isNullOrBlank(), "REDIS_TEST_URL is not set")
        val address = URI(raw!!)
        val configuration = RedisStandaloneConfiguration(address.host, if (address.port < 0) 6379 else address.port)
        val client = LettuceClientConfiguration.builder().commandTimeout(Duration.ofMillis(250)).build()
        val factory = LettuceConnectionFactory(configuration, client)
        factory.afterPropertiesSet()
        factory.start()
        factory.initConnection()
        try {
            action(factory)
        } finally {
            publishers.forEach { it.close() }
            factory.destroy()
        }
    }
}
