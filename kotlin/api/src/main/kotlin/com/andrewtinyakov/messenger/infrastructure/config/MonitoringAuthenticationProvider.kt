package com.andrewtinyakov.messenger.infrastructure.config

import org.springframework.security.authentication.AuthenticationProvider
import org.springframework.security.authentication.BadCredentialsException
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken
import org.springframework.security.core.Authentication
import org.springframework.security.core.authority.SimpleGrantedAuthority
import java.security.MessageDigest

class MonitoringAuthenticationProvider(
    username: String,
    password: String,
    roles: List<String>,
) : AuthenticationProvider {
    private val expectedUsername = digest(username)
    private val expectedPassword = digest(password)
    private val authorities = roles.map { SimpleGrantedAuthority("ROLE_$it") }

    init {
        require(username.isNotBlank() && password.isNotBlank()) { "Monitoring credentials must not be blank" }
        require(roles.isNotEmpty()) { "Monitoring credentials need at least one role" }
    }

    override fun authenticate(authentication: Authentication): Authentication {
        val username = authentication.name.orEmpty()
        val usernameMatches = MessageDigest.isEqual(digest(username), expectedUsername)
        val passwordMatches = MessageDigest.isEqual(digest(authentication.credentials?.toString().orEmpty()), expectedPassword)
        if (!(usernameMatches and passwordMatches)) throw BadCredentialsException("Invalid monitoring credentials")
        return UsernamePasswordAuthenticationToken.authenticated(username, null, authorities)
    }

    override fun supports(authentication: Class<*>): Boolean = UsernamePasswordAuthenticationToken::class.java.isAssignableFrom(
        authentication,
    )

    private fun digest(value: String): ByteArray = MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8))
}
