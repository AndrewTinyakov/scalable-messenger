package com.andrewtinyakov.messenger.read.model

internal data class CommittedAdvance(
    val advance: ReadAdvance,
    val notificationCoalesced: Boolean,
)
