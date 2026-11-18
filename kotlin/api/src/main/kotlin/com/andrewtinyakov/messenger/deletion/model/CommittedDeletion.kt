package com.andrewtinyakov.messenger.deletion.model

import com.andrewtinyakov.messenger.deletion.web.payload.DeletionResponse

internal data class CommittedDeletion(
    val response: DeletionResponse,
    val newlyAccepted: Boolean,
)
