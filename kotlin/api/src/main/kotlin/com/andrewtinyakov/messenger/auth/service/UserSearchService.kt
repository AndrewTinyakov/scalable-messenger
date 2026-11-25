package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.auth.model.User
import com.andrewtinyakov.messenger.auth.model.UserSummary
import com.andrewtinyakov.messenger.auth.repository.UserRepository
import com.andrewtinyakov.messenger.shared.web.invalidInput
import org.springframework.stereotype.Service

@Service
class UserSearchService(
    private val userRepository: UserRepository,
) {
    fun search(query: String): List<UserSummary> {
        if (query.length > User.MAX_USERNAME_LENGTH) invalidInput("query", "Query is too long")
        return userRepository.search(query = query)
    }
}
