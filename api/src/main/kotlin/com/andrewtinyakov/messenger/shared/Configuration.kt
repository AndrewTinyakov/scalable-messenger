package com.andrewtinyakov.messenger.shared

import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.core.userdetails.User
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.provisioning.InMemoryUserDetailsManager
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import java.time.Clock

@Configuration
class Configuration {
    @Bean fun clock(): Clock = Clock.systemUTC()

    @Bean fun passwordEncoder(): BCryptPasswordEncoder = BCryptPasswordEncoder()

    @Bean
    fun monitoringUsers(
        @Value("\${spring.security.user.name}") username: String,
        @Value("\${spring.security.user.password}") password: String,
        encoder: BCryptPasswordEncoder,
    ): UserDetailsService = InMemoryUserDetailsManager(
        User.withUsername(username).password(encoder.encode(password)).roles("MONITORING").build(),
    )

    @Bean
    fun securityFilterChain(
        http: HttpSecurity,
        @Value("\${messenger.web.allowed-origin}") origin: String,
    ): SecurityFilterChain {
        val cors = CorsConfiguration().apply {
            allowedOrigins = listOf(origin)
            allowedMethods = listOf("GET", "POST", "DELETE", "OPTIONS")
            allowedHeaders = listOf("Authorization", "Content-Type")
        }
        val source = UrlBasedCorsConfigurationSource().apply { registerCorsConfiguration("/**", cors) }
        return http.csrf { it.disable() }
            .cors { it.configurationSource(source) }
            .authorizeHttpRequests {
                it.requestMatchers(HttpMethod.OPTIONS, "/**").permitAll()
                    .requestMatchers("/actuator/health", "/api/v1/auth/register", "/api/v1/auth/login", "/api/v3/api-docs/**").permitAll()
                    .requestMatchers("/actuator/prometheus").hasRole("MONITORING")
                    .requestMatchers("/actuator/**").denyAll()
                    .anyRequest().permitAll()
            }.httpBasic { }.build()
    }
}
