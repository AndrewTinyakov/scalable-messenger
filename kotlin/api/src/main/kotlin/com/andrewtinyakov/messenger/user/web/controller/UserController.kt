package com.andrewtinyakov.messenger.user.web.controller

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.user.service.UserSearchService
import com.andrewtinyakov.messenger.user.web.payload.UserResponse
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/users")
class UserController(
    private val auth: AuthenticationService,
    private val users: UserSearchService,
) {
    @GetMapping
    fun search(
        @RequestHeader("Authorization", required = false) authorization: String?,
        @RequestParam(defaultValue = "") query: String,
    ): List<UserResponse> {
        auth.session(authorization)
        return users.search(query)
    }
}
