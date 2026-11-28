package com.andrewtinyakov.messenger.auth.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.isValidSessionId
import com.andrewtinyakov.messenger.auth.service.SessionManagementService
import com.andrewtinyakov.messenger.auth.web.payload.ActiveSessionsResponse
import com.andrewtinyakov.messenger.auth.web.payload.RevokedSessionsResponse
import com.andrewtinyakov.messenger.auth.web.payload.toResponse
import com.andrewtinyakov.messenger.shared.web.notFound
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpStatus
import org.springframework.web.bind.annotation.DeleteMapping
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.ResponseStatus
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/auth/sessions")
class AuthSessionController(
    private val sessionManagementService: SessionManagementService,
    private val sessionCookie: SessionCookie,
) {
    @GetMapping
    fun listSessions(
        session: AuthenticatedSession,
    ): ActiveSessionsResponse = ActiveSessionsResponse(
        sessions = sessionManagementService.listSessions(userId = session.userId).map { it.toResponse(session.sessionId) },
    )

    @DeleteMapping("/{sessionId}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    fun revokeSession(
        session: AuthenticatedSession,
        @PathVariable sessionId: String,
        response: HttpServletResponse,
    ) {
        if (!isValidSessionId(sessionId)) notFound()
        val target = SessionId(sessionId)
        sessionManagementService.revokeSession(userId = session.userId, sessionId = target)
        if (target == session.sessionId) sessionCookie.clear(response)
    }

    @PostMapping("/revoke-others")
    fun revokeOtherSessions(
        session: AuthenticatedSession,
    ): RevokedSessionsResponse = RevokedSessionsResponse(
        revokedSessions = sessionManagementService.revokeOtherSessions(userId = session.userId, currentSessionId = session.sessionId),
    )
}
