package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.repository.state.ChatStateRepository
import com.andrewtinyakov.messenger.chat.web.payload.ChatStateResponse
import com.andrewtinyakov.messenger.chat.web.payload.toResponse
import com.andrewtinyakov.messenger.infrastructure.database.ReadTransactions
import com.andrewtinyakov.messenger.shared.web.notFound
import org.springframework.stereotype.Service

@Service
class ChatStateService(
    private val chatStateRepository: ChatStateRepository,
    private val reads: ReadTransactions,
) {
    fun state(chatId: ChatId, userId: UserId, minSeq: Long?): ChatStateResponse {
        val fromReplica = minSeq?.let { floor ->
            reads.replica { chatStateRepository.find(chatId, userId)?.takeIf { it.lastSeq >= floor } }
        }
        val state = fromReplica ?: reads.primary { chatStateRepository.find(chatId, userId) }
        return state?.toResponse() ?: notFound()
    }
}
