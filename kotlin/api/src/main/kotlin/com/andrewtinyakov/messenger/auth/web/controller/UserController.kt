package com.andrewtinyakov.messenger.auth.web.controller

import com.andrewtinyakov.messenger.auth.service.UserLookupService
import com.andrewtinyakov.messenger.auth.service.UserSearchService
import com.andrewtinyakov.messenger.auth.web.payload.UserResponse
import com.andrewtinyakov.messenger.auth.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.requireId
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/users")
class UserController(
    private val userSearchService: UserSearchService,
    private val userLookupService: UserLookupService,
) {
    @GetMapping("/{userId}")
    fun get(
        @PathVariable userId: String,
    ): UserResponse = userLookupService.get(UserId(requireId(userId))).toResponse()

    @GetMapping
    fun search(
        @RequestParam(defaultValue = "") query: String,
    ): List<UserResponse> = userSearchService.search(query).map { it.toResponse() }
}
