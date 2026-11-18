package com.andrewtinyakov.messenger.infrastructure.database

import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.util.concurrent.ConcurrentHashMap

class SqlComment(
    application: String,
) {
    private val application = encode(application)
    private val comments = ConcurrentHashMap<EntryPoint, String>()

    fun prepend(sql: String, entryPoint: EntryPoint): String =
        comments.computeIfAbsent(entryPoint) { "/*application='$application',${it.kind}='${encode(it.name)}'*/ " } + sql

    private fun encode(value: String): String = URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20")
}
