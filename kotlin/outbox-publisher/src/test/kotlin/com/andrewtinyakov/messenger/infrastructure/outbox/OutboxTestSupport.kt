package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.generated.messaging.event.RoomEventType
import com.andrewtinyakov.messenger.shared.id.newId
import org.mockito.ArgumentMatchers.any
import org.mockito.Mockito.mock
import org.mockito.Mockito.`when`
import org.springframework.transaction.PlatformTransactionManager
import org.springframework.transaction.TransactionStatus
import org.springframework.transaction.support.TransactionTemplate

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
