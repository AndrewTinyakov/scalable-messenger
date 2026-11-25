package com.andrewtinyakov.messenger.infrastructure.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.security.autoconfigure.SecurityProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.core.annotation.Order
import org.springframework.http.HttpMethod
import org.springframework.security.authentication.ProviderManager
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.web.SecurityFilterChain
import org.springframework.security.web.servlet.util.matcher.PathPatternRequestMatcher
import org.springframework.security.web.util.matcher.OrRequestMatcher
import org.springframework.security.web.util.matcher.RequestMatcher

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SecurityProperties::class)
class MonitoringSecurityConfig {
    @Bean
    fun monitoringAuthenticationProvider(properties: SecurityProperties): MonitoringAuthenticationProvider =
        MonitoringAuthenticationProvider(
            username = properties.user.name,
            password = properties.user.password,
            roles = properties.user.roles.ifEmpty { listOf(MONITORING_ROLE) },
        )

    @Bean
    @Order(1)
    fun monitoringFilterChain(
        http: HttpSecurity,
        properties: WebProperties,
        provider: MonitoringAuthenticationProvider,
        matchers: PathPatternRequestMatcher.Builder,
    ): SecurityFilterChain {
        val security = properties.security
        val monitoring = matchers.paths(security.monitoringPaths)
        val public = matchers.paths(security.publicPaths)
        val preflight = matchers.paths(security.preflightPaths, HttpMethod.OPTIONS)
        http
            .securityMatcher(
                RequestMatcher { request ->
                    monitoring.matches(request) && !public.matches(request) && !preflight.matches(request)
                },
            )
            .csrf { csrf -> csrf.disable() }
            .sessionManagement { sessions -> sessions.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .requestCache { cache -> cache.disable() }
            .authenticationManager(ProviderManager(provider))
            .authorizeHttpRequests { requests -> requests.anyRequest().hasRole(MONITORING_ROLE) }
            .httpBasic { }
        return http.build()
    }

    private fun PathPatternRequestMatcher.Builder.paths(patterns: List<String>, method: HttpMethod? = null): RequestMatcher =
        if (patterns.isEmpty()) {
            RequestMatcher { false }
        } else {
            OrRequestMatcher(patterns.map { matcher(method, it) })
        }

    companion object {
        const val MONITORING_ROLE = "MONITORING"
    }
}
