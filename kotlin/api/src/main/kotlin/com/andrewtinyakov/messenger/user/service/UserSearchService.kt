package com.andrewtinyakov.messenger.user.service

import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.andrewtinyakov.messenger.user.repository.UserRepository
import com.andrewtinyakov.messenger.user.web.payload.UserResponse
import com.andrewtinyakov.messenger.user.web.payload.toResponse
import org.springframework.http.HttpStatus
import org.springframework.stereotype.Service

@Service
class UserSearchService(
    private val repository: UserRepository,
) {
    fun search(query: String): List<UserResponse> {
        if (query.length > 40) badRequest(ApiErrorCode.INVALID_QUERY, "Query is too long")
        return repository.search(query).map { it.toResponse() }
    }
}
