package com.andrewtinyakov.messenger.checks

import org.jetbrains.kotlin.lexer.KotlinLexer
import org.jetbrains.kotlin.lexer.KtTokens
import java.io.File

fun main(args: Array<String>) {
    check(args.isNotEmpty()) { "No Kotlin sources to scan" }
    val comments = args.flatMap { path -> kotlinComments(path, File(path).readText()) }
    check(comments.isEmpty()) { comments.joinToString("\n", prefix = "Kotlin source comments:\n") }
}

internal fun kotlinComments(path: String, source: String): List<String> = buildList {
    val lexer = KotlinLexer()
    lexer.start(source)
    var line = 1
    var lineStart = 0
    var offset = 0
    while (lexer.tokenType != null) {
        if (KtTokens.COMMENTS.contains(lexer.tokenType)) {
            while (offset < lexer.tokenStart) {
                if (source[offset] == '\n' || (source[offset] == '\r' && source.getOrNull(offset + 1) != '\n')) {
                    line++
                    lineStart = offset + 1
                }
                offset++
            }
            add("$path:$line:${lexer.tokenStart - lineStart + 1}: ${lexer.tokenType}")
        }
        lexer.advance()
    }
}
