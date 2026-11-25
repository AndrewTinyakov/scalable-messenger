package com.andrewtinyakov.messenger.shared.web

private const val MAX_PAGE_SIZE = 100
private val decimalSequence = Regex("0|[1-9][0-9]{0,18}")

fun requirePageLimit(limit: Int) {
    if (limit !in 1..MAX_PAGE_SIZE) {
        invalidInput(
            "limit",
            "limit must be 1 to $MAX_PAGE_SIZE",
        )
    }
}

fun parseSequence(value: String): Long? =
    value
        .takeIf(decimalSequence::matches)
        ?.toLongOrNull()
