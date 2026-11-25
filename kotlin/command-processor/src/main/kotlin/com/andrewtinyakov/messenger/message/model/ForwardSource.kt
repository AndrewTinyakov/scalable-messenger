package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.chat.model.ChatId

internal data class ForwardSource(
    val chatId: ChatId,
    val messageId: MessageId,
)
