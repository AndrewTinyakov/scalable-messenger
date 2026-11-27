package com.andrewtinyakov.messenger.checks

internal data class JooqMethod(
    val owner: String,
    val name: String,
    val descriptor: String,
) {
    override fun toString(): String = "${owner.replace('/', '.')}.$name$descriptor"
}
