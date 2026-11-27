package com.andrewtinyakov.messenger.checks

internal class JooqType(
    val parents: List<String>,
    val plainSql: Boolean,
    val plainMethods: Set<JooqMethod>,
)
