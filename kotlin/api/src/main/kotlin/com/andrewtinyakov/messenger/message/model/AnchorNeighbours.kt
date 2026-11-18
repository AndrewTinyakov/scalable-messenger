package com.andrewtinyakov.messenger.message.model

import kotlin.math.abs

internal data class AnchorNeighbours(
    val before: VisiblePage,
    val after: VisiblePage,
) {
    fun closestTo(anchorAt: Long): Message? =
        listOfNotNull(before.messages.lastOrNull(), after.messages.firstOrNull()).minByOrNull { abs(it.sequence - anchorAt) }
}
