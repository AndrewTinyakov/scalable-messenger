package com.andrewtinyakov.messenger.chat.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.auth.web.payload.toResponse
import com.andrewtinyakov.messenger.chat.web.payload.DirectChatResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service

@Service
class DirectChatLookupService(
    private val userRepository: UserRepository,
    private val directChatService: DirectChatService,
    private val chatService: ChatService,
) {
    fun get(userId: UserId, recipientId: UserId): DirectChatResponse {
        if (userId == recipientId) {
            badRequest(ApiErrorCode.INVALID_MEMBER, "Direct chat recipient must be another user")
        }
        val recipient = userRepository.findSummary(userId = recipientId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, ApiErrorCode.USER_NOT_FOUND, "User not found")
        val chat = directChatService.findBetween(userId = userId, recipientId = recipientId)
            ?.let { chatService.get(chatId = it, userId = userId) }
        return DirectChatResponse(recipient = recipient.toResponse(), chat = chat)
    }
}
