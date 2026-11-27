package com.andrewtinyakov.messenger.deletion.model

internal data class CommittedDeletion(
    val operation: StoredDeletion,
    val newlyAccepted: Boolean,
)
