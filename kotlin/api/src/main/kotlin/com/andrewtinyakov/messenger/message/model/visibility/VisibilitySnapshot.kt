package com.andrewtinyakov.messenger.message.model.visibility

data class VisibilitySnapshot(
    val snapshotSequence: Long,
    val mutationSeq: Long,
    val visibilitySeq: Long,
    val clearedThroughSequence: Long,
    val globalClearedThroughSequence: Long,
    val hidden: Boolean,
) {
    val floor: Long get() = maxOf(clearedThroughSequence, globalClearedThroughSequence)
}
