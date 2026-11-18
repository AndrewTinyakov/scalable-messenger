package com.andrewtinyakov.messenger.deletion.model

internal data class AppliedDeletion(
    val revisions: DeletionRevisions,
    val deletedRows: Int,
)
