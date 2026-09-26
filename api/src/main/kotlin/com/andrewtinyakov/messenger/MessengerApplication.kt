package com.andrewtinyakov.messenger

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

@SpringBootApplication
@EnableScheduling
class MessengerApplication

fun main(args: Array<String>) {
    runApplication<MessengerApplication>(*args)
}
