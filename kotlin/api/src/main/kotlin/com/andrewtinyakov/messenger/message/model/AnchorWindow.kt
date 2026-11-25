package com.andrewtinyakov.messenger.message.model

internal data class AnchorWindow(
    val older: VisiblePage,
    val newer: VisiblePage,
)
