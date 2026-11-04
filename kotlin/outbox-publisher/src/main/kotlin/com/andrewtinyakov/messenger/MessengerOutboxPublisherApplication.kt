package com.andrewtinyakov.messenger

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

@EnableScheduling
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
