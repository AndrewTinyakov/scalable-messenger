package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service

@Service
class UserLookupService(
    private val userRepository: UserRepository,
) {
    fun get(userId: UserId): UserSummary =
        userRepository.findSummary(userId = userId)
            ?: throw ApiException(HttpStatus.NOT_FOUND, ApiErrorCode.USER_NOT_FOUND, "User not found")
}
