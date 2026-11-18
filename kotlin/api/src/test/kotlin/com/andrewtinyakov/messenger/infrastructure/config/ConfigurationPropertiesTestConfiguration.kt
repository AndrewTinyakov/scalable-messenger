package com.andrewtinyakov.messenger.infrastructure.config

import com.andrewtinyakov.messenger.auth.config.AuthProperties
import com.andrewtinyakov.messenger.auth.config.PasswordConfig
import com.andrewtinyakov.messenger.auth.config.PasswordProperties
import com.andrewtinyakov.messenger.deletion.config.HistoryPurgeProperties
import com.andrewtinyakov.messenger.infrastructure.grpc.GrpcProperties
import com.andrewtinyakov.messenger.message.config.MessageChangeRetentionProperties
import com.andrewtinyakov.messenger.read.config.ReadProperties
import com.andrewtinyakov.messenger.ws.config.WsProperties
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.security.autoconfigure.SecurityProperties
import org.springframework.boot.webmvc.autoconfigure.WebMvcProperties
import org.springframework.context.annotation.Configuration
import org.springframework.context.annotation.Import

@Configuration(proxyBeanMethods = false)
@EnableConfigurationProperties(
    AuthProperties::class,
    WsProperties::class,
    PasswordProperties::class,
    GrpcProperties::class,
    HistoryPurgeProperties::class,
    ReadProperties::class,
    MessageChangeRetentionProperties::class,
    WebProperties::class,
    SecurityProperties::class,
    WebMvcProperties::class,
)
@Import(PasswordConfig::class)
class ConfigurationPropertiesTestConfiguration
