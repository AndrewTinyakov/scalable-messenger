package com.andrewtinyakov.messenger.infrastructure.config

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.config.PasswordConfig
import com.andrewtinyakov.messenger.auth.config.PasswordProperties
import com.andrewtinyakov.messenger.chat.grpc.GrpcProperties
import org.assertj.core.api.Assertions.assertThat
import org.junit.jupiter.api.Test
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.security.autoconfigure.SecurityProperties
import org.springframework.boot.test.context.ConfigDataApplicationContextInitializer
import org.springframework.boot.test.context.runner.ApplicationContextRunner
import org.springframework.boot.webmvc.autoconfigure.WebMvcProperties
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import
import org.springframework.security.crypto.password.PasswordEncoder

class ConfigurationPropertiesTests {
    private val runner = ApplicationContextRunner()
        .withInitializer(ConfigDataApplicationContextInitializer())
        .withUserConfiguration(PropertiesConfiguration::class.java)
        .withPropertyValues("messenger.grpc.enabled=false")

    @Test
    fun `application YAML binds password defaults and framework properties`() {
        runner.run { context ->
            assertThat(context).hasNotFailed()
            val properties = context.getBean(PasswordProperties::class.java)
            assertThat(properties.idForEncode).isEqualTo("pbkdf2-sha256-600000")
            assertThat(properties.pbkdf2.getValue(properties.idForEncode).iterations).isEqualTo(600_000)
            val encoder = context.getBean(PasswordEncoder::class.java)
            val encoded = encoder.encode("example-password")
            assertThat(encoded).startsWith("{pbkdf2-sha256-600000}")
            assertThat(encoder.matches("example-password", encoded)).isTrue()
            assertThat(context.getBean(WebMvcProperties::class.java).servlet.path).isEqualTo("/api")
            assertThat(context.getBean(SecurityProperties::class.java).user.name).isEqualTo("metrics")
        }
    }

    @Test
    fun `configuration overrides reach typed properties and select a new password encoder`() {
        runner.withPropertyValues(
            "messenger.auth.cookie-secure=false",
            "messenger.web.cors.allowed-origins[0]=https://chat.example.test",
            "spring.mvc.servlet.path=/custom-api",
            "spring.security.user.name=observer",
            "messenger.grpc.enabled=true",
            "messenger.grpc.port=9443",
            "messenger.grpc.bind-address=127.0.0.2",
            "messenger.grpc.ca-file=/tls/ca.pem",
            "messenger.grpc.cert-file=/tls/api.pem",
            "messenger.grpc.key-file=/tls/key.pem",
            "messenger.grpc.allowed-client-identity=spiffe://example/ws",
            "messenger.auth.password.id-for-encode=pbkdf2-next",
            "messenger.auth.password.pbkdf2.pbkdf2-next.iterations=1000",
            "messenger.auth.password.pbkdf2.pbkdf2-next.salt-length=24",
        ).run { context ->
            assertThat(context).hasNotFailed()
            assertThat(context.getBean(AuthProperties::class.java).cookieSecure).isFalse()
            assertThat(context.getBean(WebProperties::class.java).cors.allowedOrigins).containsExactly("https://chat.example.test")
            assertThat(context.getBean(WebMvcProperties::class.java).servlet.path).isEqualTo("/custom-api")
            assertThat(context.getBean(SecurityProperties::class.java).user.name).isEqualTo("observer")
            assertThat(context.getBean(GrpcProperties::class.java)).isEqualTo(
                GrpcProperties(true, 9443, "127.0.0.2", "/tls/ca.pem", "/tls/api.pem", "/tls/key.pem", "spiffe://example/ws"),
            )
            val encoder = context.getBean(PasswordEncoder::class.java)
            val encoded = encoder.encode("example-password")
            assertThat(encoded).startsWith("{pbkdf2-next}")
            assertThat(encoder.matches("example-password", encoded)).isTrue()
            assertThat(context.getBean(PasswordProperties::class.java).pbkdf2).containsKey("pbkdf2-sha256-600000")
        }
    }

    @Test
    fun `invalid password settings and missing enabled gRPC credentials fail binding`() {
        for (property in listOf(
            "messenger.auth.password.id-for-encode=missing",
            "messenger.auth.password.pbkdf2.pbkdf2-sha256-600000.iterations=0",
            "messenger.auth.password.pbkdf2.pbkdf2-sha256-600000.salt-length=0",
            "messenger.grpc.enabled=true",
            "messenger.auth.ws-ticket-secret=short",
        )) {
            runner.withPropertyValues(property).run { context ->
                assertThat(context).hasFailed()
            }
        }
    }

    @Configuration(proxyBeanMethods = false)
    @EnableConfigurationProperties(
        AuthProperties::class,
        PasswordProperties::class,
        GrpcProperties::class,
        WebProperties::class,
        SecurityProperties::class,
        WebMvcProperties::class,
    )
    @Import(PasswordConfig::class)
    class PropertiesConfiguration
}
