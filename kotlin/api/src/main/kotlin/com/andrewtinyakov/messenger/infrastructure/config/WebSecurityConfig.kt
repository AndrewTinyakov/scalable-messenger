package com.andrewtinyakov.messenger.infrastructure.config

import com.andrewtinyakov.messenger.auth.web.BrowserRequestFilter
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.config.http.SessionCreationPolicy
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import org.springframework.web.filter.CorsFilter

@Configuration(proxyBeanMethods = false)
class WebSecurityConfig {
    @Bean
    fun securityFilterChain(http: HttpSecurity, properties: WebProperties): SecurityFilterChain {
        val cors = CorsConfiguration().apply {
            allowedOrigins = properties.cors.allowedOrigins
            allowedMethods = properties.cors.allowedMethods
            allowedHeaders = properties.cors.allowedHeaders
            allowCredentials = properties.cors.allowCredentials
        }
        val source = UrlBasedCorsConfigurationSource().apply { registerCorsConfiguration("/**", cors) }
        http
            .csrf { csrf -> csrf.disable() }
            .addFilterAfter(BrowserRequestFilter(properties.cors.allowedOrigins), CorsFilter::class.java)
            .sessionManagement { sessions -> sessions.sessionCreationPolicy(SessionCreationPolicy.STATELESS) }
            .requestCache { cache -> cache.disable() }
            .cors { cors -> cors.configurationSource(source) }
            .authorizeHttpRequests { requests ->
                if (properties.security.preflightPaths.isNotEmpty()) {
                    requests.requestMatchers(HttpMethod.OPTIONS, *properties.security.preflightPaths.toTypedArray()).permitAll()
                }
                if (properties.security.publicPaths.isNotEmpty()) {
                    requests.requestMatchers(*properties.security.publicPaths.toTypedArray()).permitAll()
                }
                if (properties.security.monitoringPaths.isNotEmpty()) {
                    requests.requestMatchers(*properties.security.monitoringPaths.toTypedArray()).hasRole("MONITORING")
                }
                if (properties.security.deniedPaths.isNotEmpty()) {
                    requests.requestMatchers(*properties.security.deniedPaths.toTypedArray()).denyAll()
                }
                requests.anyRequest().permitAll()
            }.httpBasic { }
        return http.build()
    }
}
