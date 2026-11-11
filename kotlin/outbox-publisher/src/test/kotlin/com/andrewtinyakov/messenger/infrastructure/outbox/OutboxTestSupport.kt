package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.shared.id.EventId
import com.andrewtinyakov.messenger.shared.id.newId
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionTemplate
import java.time.OffsetDateTime

internal fun outboxEvent(targetRoom: String? = null): OutboxMessage {
    val id = EventId(newId())
    val room = targetRoom ?: "group:test-${id.value}"
    return OutboxMessage(
        id = id,
        room = room,
        payload = """{"eventId":"${id.value}","room":"$room","type":"${RoomEventType.CHAT_CREATED.value}","version":1}""",
    )
}

internal fun outboxTransactions(): TransactionTemplate {
    val manager = mock(PlatformTransactionManager::class.java)
    `when`(manager.getTransaction(any())).thenReturn(mock(TransactionStatus::class.java))
    return TransactionTemplate(manager)
}

internal class MemoryOutbox(
    initial: List<OutboxMessage>,
) : OutboxRepository {
    private val rows = initial.associateByTo(linkedMapOf()) { it.id }
    private val owners = mutableMapOf<EventId, String>()

    @Synchronized
    override fun claim(now: OffsetDateTime, limit: Int, owner: String, leaseUntil: OffsetDateTime): List<OutboxMessage> =
        rows.values.filter { row ->
            val order = row.groupPublicationOrder
            row.id !in owners && (
                order == null || rows.values.none {
                    it.room == row.room && (it.groupPublicationOrder?.let { value -> value < order } == true)
                }
            )
        }.take(limit).onEach { owners[it.id] = owner }

    @Synchronized
    override fun claimGroupTail(
        anchor: OutboxMessage,
        now: OffsetDateTime,
        limit: Int,
        owner: String,
        leaseUntil: OffsetDateTime,
    ): List<OutboxMessage> {
        val head = rows.values.firstOrNull { it.room == anchor.room }
        if (head?.id != anchor.id || owners[anchor.id] != owner) return emptyList()
        return rows.values.filter { it.room == anchor.room && it.id !in owners }
            .take(limit).onEach { owners[it.id] = owner }
    }

    @Synchronized
    override fun complete(ids: Collection<EventId>, owner: String) {
        ids.forEach { id ->
            check(owners[id] == owner)
            rows.remove(id)
            owners.remove(id)
        }
    }

    @Synchronized
    override fun enqueue(messages: Collection<OutboxMessage>) {
        messages.forEach { rows[it.id] = it }
    }

    @Synchronized
    override fun backlog(): OutboxBacklog = OutboxBacklog(rows.size.toLong(), rows.values.mapNotNull { it.createdAt }.minOrNull())

    @Synchronized
    fun remaining(): List<OutboxMessage> = rows.values.toList()
}
