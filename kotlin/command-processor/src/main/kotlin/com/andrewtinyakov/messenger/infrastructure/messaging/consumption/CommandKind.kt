package com.andrewtinyakov.messenger.infrastructure.messaging.consumption

enum class CommandKind {
    SEND,
    DEAD_LETTER,

    ;

    val metricValue: String
        get() = name.lowercase()
}
