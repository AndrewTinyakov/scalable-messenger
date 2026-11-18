package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.generated.messaging.command.SendMessageCommandV1
import org.springframework.amqp.core.Message

internal data class PendingSend(
    val message: Message,
    val command: SendMessageCommandV1,
    val target: SendTarget,
    val started: Long,
)
