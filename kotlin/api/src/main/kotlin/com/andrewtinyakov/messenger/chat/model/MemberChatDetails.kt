package com.andrewtinyakov.messenger.chat.model

import com.andrewtinyakov.messenger.auth.model.UserSummary

data class MemberChatDetails(
    val chat: Chat,
    val members: List<UserSummary>,
)
