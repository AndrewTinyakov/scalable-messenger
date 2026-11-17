package com.andrewtinyakov.messenger.message.model

data class VisibilitySnapshot(
    val snapshotSequence: Long,
    val mutationRevision: Long,
    val visibilityRevision: Long,
    val clearedThroughSequence: Long,
    val globalClearedThroughSequence: Long,
    val hidden: Boolean,
) {
    val floor: Long get() = maxOf(clearedThroughSequence, globalClearedThroughSequence)
}
