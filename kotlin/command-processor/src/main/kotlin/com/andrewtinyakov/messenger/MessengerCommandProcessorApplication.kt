package com.andrewtinyakov.messenger

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.runApplication

@SpringBootApplication
class MessengerCommandProcessorApplication

fun main(args: Array<String>) {
    runApplication<MessengerCommandProcessorApplication>(*args)
}
