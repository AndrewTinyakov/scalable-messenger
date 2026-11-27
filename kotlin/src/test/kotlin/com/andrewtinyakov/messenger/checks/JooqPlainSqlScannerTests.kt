package com.andrewtinyakov.messenger.checks

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.objectweb.asm.ClassReader
import java.io.File

class JooqPlainSqlScannerTests {
    private val fixture = "com/andrewtinyakov/messenger/checks/PlainSqlFixture"
    private val violations by lazy {
        val directories = System.getProperty("plainSqlFixture.classes").split(File.pathSeparator).map(::File)
        val scanner = JooqPlainSqlScanner(JooqPlainSqlApi(File(System.getProperty("plainSqlFixture.jooq"))))
        val classes = directories.flatMap { it.resolve(fixture.substringBeforeLast('/')).listFiles().orEmpty().toList() }
        scanner.scan(classes.filter { it.extension == "class" }.map { it.inputStream().use(::ClassReader) })
    }

    @Test
    fun `rejects plain SQL overloads and callable references`() {
        assertEquals(
            listOf("execute", "field", "field", "resultQuery", "sql"),
            violations.map { it.target.name }.sorted(),
        )
        assertTrue(violations.all { it.sourceFile == "PlainSqlFixture.kt" && it.line > 0 })
    }

    @Test
    fun `permits the name and query overloads`() {
        assertTrue(violations.none { it.caller.name in setOf("typedField", "typedQuery") })
    }

    @Test
    fun `attributes inlined calls to their Kotlin source call site`() {
        val debug = "SMAP\nCaller.kt\nKotlin\n*S KotlinDebug\n*F\n1 Caller.kt\n*L\n12#1:40,3\n18#1,2:50\n*E"
        assertEquals(mapOf(40 to 12, 41 to 12, 42 to 12, 50 to 18, 51 to 19), kotlinInlineCallSites(debug))
    }
}
