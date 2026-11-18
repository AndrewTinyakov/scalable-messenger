package com.andrewtinyakov.messenger.read.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.message.model.MessageId

internal data class ReadFixture(
    val owner: UserId,
    val members: List<UserId>,
    val chat: ChatId,
    val messages: List<MessageId>,
)
