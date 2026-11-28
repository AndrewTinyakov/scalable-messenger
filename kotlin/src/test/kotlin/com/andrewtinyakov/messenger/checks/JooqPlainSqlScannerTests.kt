package com.andrewtinyakov.messenger.checks

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.io.TempDir
import org.objectweb.asm.ClassReader
import java.io.File

class JooqPlainSqlScannerTests {
    private val fixture = "com/andrewtinyakov/messenger/checks/PlainSqlFixture"
    private val scanner by lazy { JooqPlainSqlScanner(JooqPlainSqlApi(File(System.getProperty("plainSqlFixture.jooq")))) }
    private val classes by lazy {
        System.getProperty("plainSqlFixture.classes").split(File.pathSeparator).map(::File)
            .flatMap { it.walkTopDown().filter { file -> file.extension == "class" }.toList() }
            .map { it.inputStream().use(::ClassReader) }
    }
    private val violations by lazy {
        scanner.scan(classes)
    }

    @Test
    fun `rejects plain SQL overloads and callable references`() {
        assertEquals(
            mapOf(
                "execute" to "execute",
                "field" to "field",
                "reference" to "field",
                "resultQuery" to "resultQuery",
                "sqlTaggingOutsideListener" to "sql",
                "unquotedName" to "unquotedName",
                "systemName" to "systemName",
                "keyword" to "keyword",
                "rawIndent" to "sqlIndentEnd",
                "rawContext" to "sql",
                "writeBatch" to "batchSQL",
                "writeBatchThroughAlias" to "batchSQL",
                "writeBatchThroughHelper" to "batchSQL",
                "returnLiveBatch" to "batchSQL",
            ),
            violations.filter { it.caller.owner == fixture }.associate { it.caller.name to it.target.name },
        )
        assertTrue(violations.filter { it.caller.owner == fixture }.all { it.sourceFile == "PlainSqlFixture.kt" && it.line > 0 })
    }

    @Test
    fun `permits typed queries and read access to rendered SQL`() {
        val allowed = setOf("typedField", "typedQuery", "readSql", "readBatch", "copyBatch", "describeBatch", "writeOwnArray")
        assertTrue(violations.none { it.caller.owner == fixture && it.caller.name in allowed })
    }

    @Test
    fun `permits context rendering only in PostgresStatements custom query parts`() {
        assertEquals(
            listOf("accept" to "sql", "accept" to "sql", "rawElsewhere" to "sql"),
            violations.filter { it.caller.owner.endsWith("/TypedFieldFixture") }.map { it.caller.name to it.target.name },
        )
    }

    @Test
    fun `rejects SQL strings sent through JDBC or Spring JDBC`() {
        assertEquals(
            mapOf(
                "statementExecute" to "execute",
                "statementQuery" to "executeQuery",
                "prepare" to "prepareStatement",
                "driverPrepare" to "prepareStatement",
                "template" to "update",
            ),
            violations.filter { it.caller.owner.endsWith("/JdbcSqlFixture") }.associate { it.caller.name to it.target.name },
        )
    }

    @Test
    fun `permits JDBC SQL execution and statement rendering only in PostgresStatements`() {
        assertTrue(violations.none { it.caller.owner.contains("/PostgresStatements") })
    }

    @Test
    fun `permits SQL tagging only in the database listener render hook`() {
        assertEquals(
            listOf("executeEnd" to "batchSQL", "executeEnd" to "sql", "renderEnd" to "field"),
            violations.filter { it.caller.owner.endsWith("/DatabaseQueryListener") }
                .map { it.caller.name to it.target.name }.sortedBy { it.toString() },
        )
    }

    @Test
    fun `exempts generated sources and rejects handwritten code in the same package`(
        @TempDir repository: File,
    ) {
        val probe = classes.single { it.className.endsWith("/GeneratedPackageProbe") }
        val sibling = classes.single { it.className.endsWith("/HandwrittenSibling") }
        val shared = repository.resolve("kotlin/shared")
        val output = shared.resolve("build/classes/java/main").apply { mkdirs() }
        val source = "${probe.className}.java"
        shared.resolve("src/main/java/$source").apply { parentFile.mkdirs() }.writeText("handwritten")

        fun scan() = scanner.scan(listOf(probe, sibling)) { !isGeneratedJooqClass(repository, output, it) }
            .map { it.caller.owner }.sorted()
        assertEquals(listOf(probe.className, sibling.className), scan())

        shared.resolve("src/main/java/$source").delete()
        shared.resolve("src/generated/java/$source").apply { parentFile.mkdirs() }.writeText("generated")
        assertEquals(listOf(sibling.className), scan())
    }

    @Test
    fun `attributes inlined calls to their Kotlin source call site`() {
        val debug = "SMAP\nCaller.kt\nKotlin\n*S KotlinDebug\n*F\n1 Caller.kt\n*L\n12#1:40,3\n18#1,2:50\n*E"
        assertEquals(mapOf(40 to 12, 41 to 12, 42 to 12, 50 to 18, 51 to 19), kotlinInlineCallSites(debug))
    }
}
