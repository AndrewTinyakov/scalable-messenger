package com.andrewtinyakov.messenger.checks

internal data class JooqMethod(
    val owner: String,
    val name: String,
    val descriptor: String,
) {
    fun isSqlTaggingMethod(): Boolean = owner == "org/jooq/ExecuteContext" &&
        ((name == "sql" && descriptor == "(Ljava/lang/String;)V") || (name == "batchSQL" && descriptor == "()[Ljava/lang/String;"))

    override fun toString(): String = "${owner.replace('/', '.')}.$name$descriptor"
}
