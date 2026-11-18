package com.andrewtinyakov.messenger.auth.model

data class PasswordChange(
    val credentials: SessionCredentials,
    val revokedOtherSessions: Int,
)
