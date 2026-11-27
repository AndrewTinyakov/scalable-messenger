package com.andrewtinyakov.messenger.checks

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
}
