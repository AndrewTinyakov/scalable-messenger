package com.andrewtinyakov.messenger.auth.config

import org.springframework.context.annotation.Bean
import org.springframework.context.annotation.Configuration
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder
import org.springframework.security.crypto.password.DelegatingPasswordEncoder
import org.springframework.security.crypto.password.PasswordEncoder
import org.springframework.security.crypto.password.Pbkdf2PasswordEncoder

@Configuration(proxyBeanMethods = false)
class PasswordConfig {
    @Bean
    fun passwordEncoder(properties: PasswordProperties): PasswordEncoder {
        val encoders = properties.pbkdf2.mapValues { (_, settings) ->
            Pbkdf2PasswordEncoder("", settings.saltLength, settings.iterations, settings.algorithm).apply {
                setEncodeHashAsBase64(settings.encodeHashAsBase64)
            }
        }
        val bcrypt = BCryptPasswordEncoder()
        return DelegatingPasswordEncoder(properties.idForEncode, encoders + ("bcrypt" to bcrypt)).apply {
            setDefaultPasswordEncoderForMatches(bcrypt)
        }
    }
}
