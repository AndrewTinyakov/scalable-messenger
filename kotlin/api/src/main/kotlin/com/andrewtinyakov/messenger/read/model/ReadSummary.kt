package com.andrewtinyakov.messenger.read.model

data class ReadSummary(
    val throughSequence: Long,
    val maxOtherReadSequence: Long,
)
