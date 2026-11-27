package com.andrewtinyakov.messenger.checks

internal data class JooqPlainSqlViolation(
    val caller: JooqMethod,
    val sourceFile: String?,
    val line: Int,
    val target: JooqMethod,
)
