package com.andrewtinyakov.messenger.chat.model

data class ChatState(
    val lastSeq: Long,
    val pinsSeq: Long,
    val mutationFloor: Long,
    val mutationSeq: Long,
    val memberSeq: Long,
    val clearedThroughSequence: Long,
    val globalClearedThroughSequence: Long,
    val hidden: Boolean,
    val ownReadThrough: Long,
    val otherReadThrough: Long,
    val userSeq: Long,
)
