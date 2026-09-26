package com.andrewtinyakov.messenger.auth

import com.andrewtinyakov.messenger.shared.ApiException
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RequestParam
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/auth")
class AuthController(
    private val auth: AuthService,
) {
    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    fun register(
        @Valid @RequestBody input: Credentials,
    ): AuthView = auth.register(input)

    @PostMapping("/login")
    fun login(
        @Valid @RequestBody input: Credentials,
    ): AuthView = auth.login(input)

    @GetMapping("/session")
    fun session(
        @RequestHeader("Authorization", required = false) authorization: String?,
    ): SessionView = auth.session(authorization)
}

@RestController
@RequestMapping("/v1/users")
class UsersController(
    private val auth: AuthService,
    private val repository: AuthRepository,
) {
    @GetMapping
    fun search(
        @RequestHeader("Authorization", required = false) authorization: String?,
        @RequestParam(defaultValue = "") query: String,
    ): List<UserView> {
        auth.session(authorization)
        if (query.length > 40) throw ApiException(400, "INVALID_QUERY", "Query is too long")
        return repository.searchUsers(query)
    }
}
