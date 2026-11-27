package com.andrewtinyakov.messenger.checks

private val smapLine = Regex("""(\d+)(?:#\d+)?(?:,(\d+))?:(\d+)(?:,(\d+))?""")

internal fun kotlinInlineCallSites(debug: String?): Map<Int, Int> = buildMap {
    debug.orEmpty().lineSequence()
        .dropWhile { it != "*S KotlinDebug" }
        .drop(1)
        .dropWhile { it != "*L" }
        .drop(1)
        .takeWhile { !it.startsWith('*') }
        .forEach { entry ->
            val match = checkNotNull(smapLine.matchEntire(entry)) { "Invalid KotlinDebug SMAP line $entry" }
            val (input, count, output, increment) = match.destructured
            val stride = increment.toIntOrNull() ?: 1
            repeat(count.toIntOrNull() ?: 1) { sourceOffset ->
                repeat(stride) { generatedOffset ->
                    put(output.toInt() + sourceOffset * stride + generatedOffset, input.toInt() + sourceOffset)
                }
            }
        }
}
