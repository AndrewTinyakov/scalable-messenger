package com.andrewtinyakov.messenger.auth.web

import com.andrewtinyakov.messenger.auth.model.ExpectedSessionIdentity
import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.stereotype.Component
import org.springframework.web.servlet.HandlerInterceptor
import org.springframework.web.servlet.resource.ResourceHttpRequestHandler

const val AUTHENTICATED_SESSION_ATTRIBUTE = "authenticatedSession"

@Component
class ApiSessionInterceptor(
    private val authenticationService: AuthenticationService,
    private val cookies: SessionCookie,
) : HandlerInterceptor {
    override fun preHandle(request: HttpServletRequest, response: HttpServletResponse, handler: Any): Boolean {
        if (handler is ResourceHttpRequestHandler) return true
        val session = authenticationService.authenticatedSession(cookies.read(request))
        authenticationService.requireExpectedIdentity(expectedIdentity = request.expectedSessionIdentity(), session = session)
        request.setAttribute(AUTHENTICATED_SESSION_ATTRIBUTE, session)
        return true
    }
}

fun HttpServletRequest.expectedSessionIdentity(): ExpectedSessionIdentity = ExpectedSessionIdentity(
    userIds = getHeaders("X-Messenger-User").toList(),
    deviceIds = getHeaders("X-Messenger-Device").toList(),
)
