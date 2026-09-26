package com.andrewtinyakov.messenger.shared

import com.fasterxml.jackson.databind.DeserializationFeature
import com.fasterxml.jackson.databind.MapperFeature
import org.springframework.beans.factory.annotation.Value
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.http.HttpMethod
import org.springframework.security.config.annotation.web.builders.HttpSecurity
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.web.SecurityFilterChain
import org.springframework.web.cors.CorsConfiguration
import org.springframework.web.cors.UrlBasedCorsConfigurationSource
import java.time.Clock

@Configuration
class Configuration {
    @Bean fun clock(): Clock = Clock.systemUTC()

    @Bean fun passwordEncoder(): BCryptPasswordEncoder = BCryptPasswordEncoder()

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
                    .requestMatchers("/actuator/**").denyAll()
                    .anyRequest().permitAll()
            }.build()
    }

    @Bean
    fun strictMapperCustomizer(): org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer =
        org.springframework.boot.autoconfigure.jackson.Jackson2ObjectMapperBuilderCustomizer { builder ->
            builder.featuresToEnable(
                DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES,
                DeserializationFeature.FAIL_ON_NULL_FOR_PRIMITIVES,
            )
            builder.featuresToDisable(DeserializationFeature.ACCEPT_FLOAT_AS_INT, MapperFeature.ALLOW_COERCION_OF_SCALARS)
        }
}
