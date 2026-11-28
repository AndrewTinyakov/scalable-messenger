package com.andrewtinyakov.messenger.infrastructure.database

import org.jooq.DataType
import org.jooq.Field
import org.jooq.impl.DSL

fun <T> postgresFunction(name: String, type: DataType<T>, vararg arguments: Field<*>): Field<T> =
    DSL.function(DSL.name("pg_catalog", name), type, *arguments)
