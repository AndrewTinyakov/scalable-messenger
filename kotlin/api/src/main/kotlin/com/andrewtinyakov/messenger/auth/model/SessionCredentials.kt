package com.andrewtinyakov.messenger.auth.model

import com.andrewtinyakov.messenger.shared.id.SessionToken

data class SessionCredentials(
    val token: SessionToken,
    val user: UserSummary,
    val session: AuthenticatedSession,
)
