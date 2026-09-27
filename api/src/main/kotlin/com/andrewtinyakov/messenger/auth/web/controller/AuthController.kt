package com.andrewtinyakov.messenger.auth.web.controller

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.service.WsTicketService
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.auth.web.payload.AuthResponse
import com.andrewtinyakov.messenger.auth.web.payload.SessionResponse
import com.andrewtinyakov.messenger.auth.web.payload.WsTicketResponse
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/auth")
class AuthController(
    private val auth: AuthenticationService,
    private val tickets: WsTicketService,
) {
    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    fun register(
        @Valid @RequestBody input: AuthRequest,
    ): AuthResponse = auth.register(input)

    @PostMapping("/login")
    fun login(
        @Valid @RequestBody input: AuthRequest,
    ): AuthResponse = auth.login(input)

    @GetMapping("/session")
    fun session(
        @RequestHeader("Authorization", required = false) authorization: String?,
    ): SessionResponse = auth.session(authorization)

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun logout(
        @RequestHeader("Authorization", required = false) authorization: String?,
    ) = auth.logout(authorization)

    @PostMapping("/ws-ticket")
    fun wsTicket(
        @RequestHeader("Authorization", required = false) authorization: String?,
    ): WsTicketResponse =
        tickets.issue(auth.authenticatedSession(authorization))
}
