package com.andrewtinyakov.messenger.checks

import org.jooq.Context
import org.jooq.impl.CustomField
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType.INTEGER

class TypedFieldFixture : CustomField<Int>(DSL.name("typed_expression"), INTEGER) {
    override fun accept(ctx: Context<*>) {
        ctx.sql('(').visit(DSL.inline(42)).sql(")")
    }

    fun rawElsewhere(ctx: Context<*>) = ctx.sql("select 1")
}
