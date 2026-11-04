package com.andrewtinyakov.messenger.auth.model

data class ExpectedSessionIdentity(
    val userIds: List<String> = emptyList(),
    val deviceIds: List<String> = emptyList(),
) {
    fun matches(session: AuthenticatedSession): Boolean =
        (userIds.isEmpty() && deviceIds.isEmpty()) ||
            (userIds == listOf(session.userId.value) && deviceIds == listOf(session.deviceId.value))
}
