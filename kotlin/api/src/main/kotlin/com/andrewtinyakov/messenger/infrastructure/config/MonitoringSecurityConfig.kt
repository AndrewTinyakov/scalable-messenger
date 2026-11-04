package com.andrewtinyakov.messenger.infrastructure.config

import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.security.autoconfigure.SecurityProperties
import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.core.userdetails.User
import org.springframework.security.core.userdetails.UserDetailsService
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.provisioning.InMemoryUserDetailsManager

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(SecurityProperties::class)
class MonitoringSecurityConfig {
    @Bean
    fun monitoringUsers(properties: SecurityProperties, encoder: PasswordEncoder): UserDetailsService = InMemoryUserDetailsManager(
        User.withUsername(properties.user.name).password(encoder.encode(properties.user.password)).roles("MONITORING").build(),
    )
}
