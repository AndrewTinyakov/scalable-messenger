package com.andrewtinyakov.messenger.auth.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.service.PasswordChangeService
import com.andrewtinyakov.messenger.auth.service.UserLookupService
import com.andrewtinyakov.messenger.auth.web.payload.AuthRequest
import com.andrewtinyakov.messenger.auth.web.payload.AuthResponse
import com.andrewtinyakov.messenger.auth.web.payload.ChangePasswordRequest
import com.andrewtinyakov.messenger.auth.web.payload.RevokedSessionsResponse
import com.andrewtinyakov.messenger.auth.web.payload.SessionResponse
import com.andrewtinyakov.messenger.auth.web.payload.toAuthResponse
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import jakarta.validation.Valid
import org.springframework.http.HttpHeaders
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
    private val passwordChangeService: PasswordChangeService,
    private val userLookupService: UserLookupService,
    private val sessionCookie: SessionCookie,
) {
    @PostMapping("/register")
    @ResponseStatus(HttpStatus.CREATED)
    fun register(
        @Valid @RequestBody input: AuthRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): AuthResponse {
        val credentials = authenticationService.register(
            username = input.username,
            password = input.password,
            deviceId = input.deviceId,
            userAgent = request.getHeader(HttpHeaders.USER_AGENT),
        )
        return credentials.issueCookie(response)
    }

    @PostMapping("/login")
    fun login(
        @Valid @RequestBody input: AuthRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): AuthResponse {
        val credentials = authenticationService.login(
            username = input.username,
            password = input.password,
            deviceId = input.deviceId,
            userAgent = request.getHeader(HttpHeaders.USER_AGENT),
            clientIp = request.remoteAddr,
        )
        return credentials.issueCookie(response)
    }

    @GetMapping("/session")
    fun session(
        session: AuthenticatedSession,
    ): SessionResponse {
        val user = userLookupService.get(session.userId)
        return SessionResponse(userId = user.id.value, username = user.username, deviceId = session.deviceId.value)
    }

    @PostMapping("/password")
    fun changePassword(
        session: AuthenticatedSession,
        @Valid @RequestBody input: ChangePasswordRequest,
        request: HttpServletRequest,
        response: HttpServletResponse,
    ): RevokedSessionsResponse {
        val change = passwordChangeService.changePassword(
            userId = session.userId,
            currentSessionId = session.sessionId,
            currentPassword = input.currentPassword,
            newPassword = input.newPassword,
            clientIp = request.remoteAddr,
            userAgent = request.getHeader(HttpHeaders.USER_AGENT),
        )
        change.credentials.issueCookie(response)
        return RevokedSessionsResponse(revokedSessions = change.revokedOtherSessions)
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun logout(
        request: HttpServletRequest,
        response: HttpServletResponse,
    ) {
        authenticationService.logout(token = sessionCookie.read(request), expectedIdentity = request.expectedSessionIdentity())
        sessionCookie.clear(response)
    }

    private fun SessionCredentials.issueCookie(response: HttpServletResponse): AuthResponse {
        sessionCookie.issue(response = response, token = token)
        return toAuthResponse()
    }
}
