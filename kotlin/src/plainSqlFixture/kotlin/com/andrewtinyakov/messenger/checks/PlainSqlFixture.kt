package com.andrewtinyakov.messenger.checks

import org.jooq.Context
import org.jooq.DSLContext
import org.jooq.ExecuteContext
import org.jooq.Field
import org.jooq.impl.DSL
import org.jooq.impl.DSL.field as jooqField

class PlainSqlFixture {
    fun field() = jooqField("1 + 1")

    fun resultQuery(db: DSLContext, value: Int) = db.resultQuery("select $value")

    fun execute(db: DSLContext, statement: String) = db.execute(statement)

    fun reference() = java.util.function.Function<String, Field<*>>(DSL::field)

    fun typedField() = DSL.field(DSL.name("field"), String::class.java)

    fun typedQuery(db: DSLContext) = db.execute(db.select(DSL.inline(1)))

    fun sqlTaggingOutsideListener(context: ExecuteContext) = context.sql("select 1")

    fun unquotedName() = DSL.unquotedName("1 + 1")

    fun systemName() = DSL.systemName("1 + 1")

    fun keyword() = DSL.keyword("1 + 1")

    fun rawIndent(context: Context<*>) = context.sqlIndentEnd("1 + 1")

    fun readSql(context: ExecuteContext) = context.sql()

    fun readBatch(context: ExecuteContext): String = context.batchSQL()[0]

    fun copyBatch(context: ExecuteContext): Array<String> = context.batchSQL().clone()

    fun describeBatch(context: ExecuteContext) = context.batchSQL().contentToString()

    fun writeBatch(context: ExecuteContext) {
        context.batchSQL()[0] = "select 1"
    }

    fun writeBatchThroughAlias(context: ExecuteContext, other: Array<String>, chooseBatch: Boolean) {
        val batch = if (chooseBatch) context.batchSQL() else other
        batch[0] = "select 1"
    }

    fun writeBatchThroughHelper(context: ExecuteContext) = java.util.Arrays.fill(context.batchSQL(), "select 1")

    fun writeOwnArray(context: ExecuteContext) {
        val own = arrayOf(readBatch(context))
        own[0] = "select 1"
    }

    fun returnLiveBatch(context: ExecuteContext) = context.batchSQL()

    fun rawContext(context: Context<*>) = context.sql("select 1")
}
