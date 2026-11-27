package com.andrewtinyakov.messenger.auth.web.controller

import com.andrewtinyakov.messenger.auth.config.AuthProperties
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
import java.time.Duration

@Component
class SessionCookie(
    private val properties: AuthProperties,
    mvc: WebMvcProperties,
) {
    val name = if (properties.cookieSecure) SECURE_NAME else NAME
    private val path = if (properties.cookieSecure) "/" else mvc.servlet.path

    fun read(request: HttpServletRequest): SessionToken? {
        val values = request.cookies.orEmpty().filter { it.name == name }.map { it.value }
        if (values.isEmpty()) return null
        if (values.size != 1 || !isValidSessionToken(values.single())) {
            unauthorized(ApiErrorCode.UNAUTHORIZED, "Invalid session cookie")
        }
        return SessionToken(values.single())
    }

    fun issue(response: HttpServletResponse, token: SessionToken) {
        write(response = response, value = token.value, maxAge = LIFETIME)
    }

    fun clear(response: HttpServletResponse) {
        write(response = response, value = "", maxAge = Duration.ZERO)
    }

    private fun write(response: HttpServletResponse, value: String, maxAge: Duration) {
        response.addHeader(
            HttpHeaders.SET_COOKIE,
            ResponseCookie.from(name, value)
                .path(path)
                .httpOnly(true)
                .secure(properties.cookieSecure)
                .sameSite("Strict")
                .maxAge(maxAge)
                .build()
                .toString(),
        )
    }

    companion object {
        const val NAME = "messenger_session"
        const val SECURE_NAME = "__Host-messenger_session"
        val LIFETIME: Duration = Duration.ofDays(400)
    }
}
