package com.andrewtinyakov.messenger.auth.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.service.UserLookupService
import com.andrewtinyakov.messenger.auth.service.WsTicketService
import com.andrewtinyakov.messenger.auth.web.SessionCookie
import com.andrewtinyakov.messenger.auth.web.expectedSessionIdentity
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.auth.web.payload.AuthResponse
import com.andrewtinyakov.messenger.auth.web.payload.SessionResponse
import com.andrewtinyakov.messenger.auth.web.payload.WsTicketResponse
import com.andrewtinyakov.messenger.auth.web.payload.toAuthResponse
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/auth")
class AuthController(
    private val authenticationService: AuthenticationService,
    private val userLookupService: UserLookupService,
    private val wsTicketService: WsTicketService,
    private val cookies: SessionCookie,
) {
    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    fun register(
        @Valid @RequestBody input: AuthRequest,
        response: HttpServletResponse,
    ): AuthResponse {
        val credentials = authenticationService.register(input)
        cookies.issue(response = response, credentials = credentials)
        return credentials.toAuthResponse()
    }

    @PostMapping("/login")
    fun login(
        @Valid @RequestBody input: AuthRequest,
        response: HttpServletResponse,
    ): AuthResponse {
        val credentials = authenticationService.login(input)
        cookies.issue(response = response, credentials = credentials)
        return credentials.toAuthResponse()
    }

    @GetMapping("/session")
    fun session(
        session: AuthenticatedSession,
    ): SessionResponse {
        val user = userLookupService.get(session.userId)
        return SessionResponse(userId = user.id.value, username = user.username, deviceId = session.deviceId.value)
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun logout(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        authenticationService.logout(token = cookies.read(request), expectedIdentity = request.expectedSessionIdentity())
        cookies.clear(response)
    }

    @PostMapping("/ws-ticket")
    fun wsTicket(
        session: AuthenticatedSession,
    ): WsTicketResponse = wsTicketService.issue(session)
}
