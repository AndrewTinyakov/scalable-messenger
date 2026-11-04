package com.andrewtinyakov.messenger.auth.model

import com.andrewtinyakov.messenger.shared.id.UserId

data class UserSummary(
    val id: UserId,
    val username: String,
)
