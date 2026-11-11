package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.web.userNotFound
import org.springframework.stereotype.Service

@Service
class UserLookupService(
    private val userRepository: UserRepository,
) {
    fun get(userId: UserId): UserSummary =
        userRepository.findSummary(userId = userId)
            ?: userNotFound()
}
