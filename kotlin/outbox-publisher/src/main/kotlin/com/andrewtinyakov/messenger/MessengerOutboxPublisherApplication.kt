package com.andrewtinyakov.messenger

import com.andrewtinyakov.messenger.auth.repository.JooqUserRepository
import com.andrewtinyakov.messenger.infrastructure.database.DatabaseObservationConfiguration
import com.andrewtinyakov.messenger.infrastructure.outbox.OutboxPublisherProperties
import com.andrewtinyakov.messenger.message.repository.JooqMessageRepository
import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.context.properties.EnableConfigurationProperties
import org.springframework.boot.runApplication
import org.springframework.context.annotation.Import
import org.springframework.scheduling.annotation.EnableScheduling

@Import(DatabaseObservationConfiguration::class, JooqMessageRepository::class, JooqUserRepository::class)
@EnableScheduling
@EnableConfigurationProperties(OutboxPublisherProperties::class)
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
