package com.andrewtinyakov.messenger.auth.model

data class SessionCredentials(
    val token: SessionToken,
    val user: UserSummary,
    val session: AuthenticatedSession,
)
