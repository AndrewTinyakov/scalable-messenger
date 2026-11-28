package com.andrewtinyakov.messenger.checks

import org.jetbrains.kotlin.lexer.KotlinLexer
import org.jetbrains.kotlin.lexer.KtTokens

internal const val MESSENGER_PACKAGE = "com.andrewtinyakov.messenger"
internal val WEB_PAYLOAD = listOf("web", "payload")

internal fun messengerPackageParts(name: String): List<String>? = when {
    name == MESSENGER_PACKAGE -> emptyList()
    name.startsWith("$MESSENGER_PACKAGE.") -> name.removePrefix("$MESSENGER_PACKAGE.").split('.')
    else -> null
}

internal fun inLayer(parts: List<String>, layer: String): Boolean = if (parts.firstOrNull() in setOf("infrastructure", "shared")) {
    layer in parts.drop(1)
} else {
    parts.getOrNull(1) == layer
}

internal fun isForbiddenDependency(parts: List<String>, name: String): Boolean = when {
    inLayer(parts, "service") -> {
        (name.isUnder("org.jooq") && !name.isUnder("org.jooq.exception")) ||
            name.isUnder("$MESSENGER_PACKAGE.infrastructure.database.generated")
    }

    inLayer(parts, "model") || inLayer(parts, "repository") -> {
        messengerPackageParts(name)?.windowed(2)?.any { it == WEB_PAYLOAD } == true
    }

    else -> {
        false
    }
}

internal fun qualifiedReferences(source: String): Set<String> = buildSet {
    val lexer = KotlinLexer()
    lexer.start(source)
    while (lexer.tokenType != null) {
        if (lexer.tokenType != KtTokens.IDENTIFIER) {
            lexer.advance()
            continue
        }
        val root = lexer.tokenText.trim('`')
        if (root != "org" && root != "com") {
            lexer.advance()
            continue
        }
        val parts = mutableListOf(root)
        lexer.advancePastTrivia()
        while (lexer.tokenType == KtTokens.DOT) {
            lexer.advancePastTrivia()
            if (lexer.tokenType != KtTokens.IDENTIFIER) break
            parts += lexer.tokenText.trim('`')
            lexer.advancePastTrivia()
        }
        if (parts.size > 1) add(parts.joinToString("."))
    }
}

private fun KotlinLexer.advancePastTrivia() {
    do {
        advance()
    } while (KtTokens.WHITE_SPACE_OR_COMMENT_BIT_SET.contains(tokenType))
}

private fun String.isUnder(name: String): Boolean = this == name || startsWith("$name.")
