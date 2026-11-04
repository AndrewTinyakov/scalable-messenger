package com.andrewtinyakov.messenger.infrastructure.messaging

enum class CommandKind {
    SEND,
    DEAD_LETTER,

    ;

    val metricValue: String
        get() = name.lowercase()
}
