package com.andrewtinyakov.messenger.read.model

data class ReadAdvance(
    val progress: ReadProgress,
    val advanced: Boolean,
    val rangesWritten: Int = 0,
)
