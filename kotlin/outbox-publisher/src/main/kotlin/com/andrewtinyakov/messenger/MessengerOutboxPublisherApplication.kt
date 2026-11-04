package com.andrewtinyakov.messenger

import com.andrewtinyakov.messenger.infrastructure.database.observability.DatabaseObservationConfiguration
import com.andrewtinyakov.messenger.infrastructure.outbox.PublisherProperties
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Import
import org.springframework.scheduling.annotation.EnableScheduling

@Import(DatabaseObservationConfiguration::class)
@EnableScheduling
@EnableConfigurationProperties(PublisherProperties::class)
@SpringBootApplication(
    scanBasePackages = [
        "com.andrewtinyakov.messenger.infrastructure.outbox",
        "com.andrewtinyakov.messenger.infrastructure.redis",
        "com.andrewtinyakov.messenger.infrastructure.config",
    ],
)
class MessengerOutboxPublisherApplication

fun main(args: Array<String>) {
    runApplication<MessengerOutboxPublisherApplication>(*args)
}
