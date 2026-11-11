package com.andrewtinyakov.messenger.chat.grpc.model

import com.andrewtinyakov.messenger.chat.model.ChatId

data class GroupAuthorization(
    val authorizedChatIds: Set<ChatId>,
)
