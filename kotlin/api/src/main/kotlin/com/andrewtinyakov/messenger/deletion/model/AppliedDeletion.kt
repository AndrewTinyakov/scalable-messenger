package com.andrewtinyakov.messenger.deletion.model

internal data class AppliedDeletion(
    val sequences: DeletionSequences,
    val deletedRows: Int,
)
