package com.andrewtinyakov.messenger.auth.web

import jakarta.servlet.FilterChain
import jakarta.servlet.http.HttpServletRequest
import jakarta.servlet.http.HttpServletResponse
import org.springframework.http.HttpStatus
import org.springframework.web.filter.OncePerRequestFilter
import java.net.URI

class BrowserRequestFilter(
    private val allowedOrigins: List<String>,
) : OncePerRequestFilter() {
    init {
        require(allowedOrigins.isNotEmpty())
        for (origin in allowedOrigins) {
            val parsed = URI(origin)
            require(parsed.scheme in setOf("http", "https") && parsed.host != null && parsed.rawAuthority == parsed.authority)
            require(parsed.userInfo == null && parsed.rawQuery == null && parsed.rawFragment == null && parsed.rawPath.isNullOrEmpty())
            require(parsed.host == parsed.host.lowercase() && parsed.port in -1..65535)
            require(parsed.port != if (parsed.scheme == "https") 443 else 80)
            require(origin == "${parsed.scheme}://${parsed.rawAuthority}")
        }
    }

    override fun shouldNotFilter(request: HttpServletRequest): Boolean =
        request.method in setOf("GET", "HEAD", "OPTIONS") || !(request.pathInfo ?: request.servletPath).startsWith("/v1/")

    override fun doFilterInternal(request: HttpServletRequest, response: HttpServletResponse, chain: FilterChain) {
        val origins = request.getHeaders("Origin").toList()
        if (origins.size != 1 || origins.single() !in allowedOrigins || request.getHeaders("X-Messenger-CSRF").toList() != listOf("1")) {
            response.status = HttpStatus.FORBIDDEN.value()
            response.contentType = "application/problem+json"
            response.writer.write("""{"status":403,"detail":"Invalid browser request","code":"FORBIDDEN"}""")
            return
        }
        chain.doFilter(request, response)
    }
}
