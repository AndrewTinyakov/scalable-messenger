package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import org.springframework.stereotype.Service

@Service
class UserSearchService(
    private val userRepository: UserRepository,
) {
    fun search(query: String): List<UserSummary> {
        if (query.length > 40) badRequest(ApiErrorCode.INVALID_QUERY, "Query is too long")
        return userRepository.search(query = query)
    }
}
