package com.andrewtinyakov.messenger.auth.web

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.model.SessionCredentials
import com.andrewtinyakov.messenger.auth.model.SessionToken
import com.andrewtinyakov.messenger.auth.model.isValidSessionToken
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.unauthorized
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.boot.webmvc.autoconfigure.WebMvcProperties
import org.springframework.http.HttpHeaders
import org.springframework.http.ResponseCookie
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Duration

@Component
class SessionCookie(
    private val properties: AuthProperties,
    private val mvc: WebMvcProperties,
    private val clock: Clock,
) {
    fun read(request: HttpServletRequest): SessionToken? {
        val values = request.cookies.orEmpty().filter { it.name == NAME }.map { it.value }
        if (values.isEmpty()) return null
        if (values.size != 1 || !isValidSessionToken(values.single())) {
            unauthorized(ApiErrorCode.UNAUTHORIZED, "Invalid session cookie")
        }
        return SessionToken(values.single())
    }

    fun issue(response: HttpServletResponse, credentials: SessionCredentials) {
        write(
            response = response,
            value = credentials.token.value,
            maxAge = Duration.between(clock.instant(), credentials.session.expiresAt),
        )
    }

    fun clear(response: HttpServletResponse) {
        write(response = response, value = "", maxAge = Duration.ZERO)
    }

    private fun write(response: HttpServletResponse, value: String, maxAge: Duration) {
        response.addHeader(
            HttpHeaders.SET_COOKIE,
            ResponseCookie.from(
                NAME,
                value,
            ).path(mvc.servlet.path).httpOnly(true).secure(properties.cookieSecure).sameSite("Strict").maxAge(maxAge).build().toString(),
        )
    }

    companion object {
        const val NAME = "messenger_session"
    }
}
