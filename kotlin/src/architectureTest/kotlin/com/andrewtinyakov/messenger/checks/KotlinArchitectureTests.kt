package com.andrewtinyakov.messenger.checks

import com.lemonappdev.konsist.api.Konsist
import com.lemonappdev.konsist.api.declaration.KoClassDeclaration
import com.lemonappdev.konsist.api.declaration.KoFileDeclaration
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.junit.jupiter.api.TestInstance
import java.io.File

@TestInstance(TestInstance.Lifecycle.PER_CLASS)
class KotlinArchitectureTests {
    private val repository = File(System.getProperty("messenger.repository")).canonicalFile
    private val sources = System.getProperty("messenger.architectureFiles").split(File.pathSeparator).map { File(it).canonicalFile }.toSet()
    private val sourceDirectories = sources.map { source ->
        val segments = source.relativeTo(repository).invariantSeparatorsPath.split('/')
        if (segments.first() == "kotlin") {
            repository.resolve(segments.take(5).joinToString("/"))
        } else {
            repository.resolve("tests/sidebar-benchmark/kotlin")
        }
    }.distinct()
    private val scope = Konsist.scopeFromExternalDirectories(sourceDirectories.map { it.path })
        .slice { File(it.path).canonicalFile in sources }
    private val production = scope.slice { it.relativePath().matches(Regex("kotlin/[^/]+/src/main/.*")) }

    @Test
    fun `reads every handwritten application source`() {
        check(sources.isNotEmpty())
        assertEquals(sources, scope.files.map { File(it.path).canonicalFile }.toSet())
    }

    @Test
    fun `feature packages contain only layers`() {
        val invalid = production.files.filter { file ->
            val parts = file.packageParts
            when {
                parts == null -> true
                parts.isEmpty() -> file.classes(includeNested = false).none { it.name.endsWith("Application") }
                parts.first() in setOf("infrastructure", "shared") -> false
                parts.getOrNull(1) == "web" -> parts.getOrNull(2) !in setOf("controller", "payload")
                else -> parts.getOrNull(1) !in FEATURE_LAYERS
            }
        }
        assertNone(invalid.map { it.relativePath() })
    }

    @Test
    fun `each top level type has its own named file outside web payloads`() {
        val invalid = scope.files.filter { file ->
            val types = file.classesAndInterfacesAndObjects(includeNested = false)
            !file.inWebPayload && (types.size > 1 || types.any { it.name != File(file.path).nameWithoutExtension })
        }
        assertNone(invalid.map { it.relativePath() })
    }

    @Test
    fun `service classes end in Service and do not import jOOQ query types`() {
        val invalid = production.files.filter { it.featureLayer == "service" }.flatMap { file ->
            val invalidNames = file.classes(includeNested = false).filterNot { it.name.endsWith("Service") }.map { it.name }
            val invalidImports = file.imports.filter {
                it.name == "org.jooq" ||
                    (it.name.startsWith("org.jooq.") && !it.name.startsWith("org.jooq.exception.")) ||
                    it.name.startsWith("$ROOT_PACKAGE.infrastructure.database.generated.")
            }.map { it.name }
            (invalidNames + invalidImports).map { "${file.relativePath()} $it" }
        }
        assertNone(invalid)
    }

    @Test
    fun `scheduled methods belong to Scheduler classes in scheduling`() {
        val invalid = production.functions().filter { function ->
            function.annotations.any { it.fullyQualifiedName in SCHEDULED_ANNOTATIONS } &&
                (
                    !function.containingFile.inLayer("scheduling") ||
                        (function.containingDeclaration as? KoClassDeclaration)?.name?.endsWith("Scheduler") != true
                )
        }
        assertNone(invalid.map { "${it.containingFile.relativePath()}:${it.name}" })
    }

    @Test
    fun `transactions use explicit TransactionTemplate boundaries`() {
        val forbidden = scope.annotations.filter { it.fullyQualifiedName in TRANSACTIONAL_ANNOTATIONS }
        assertNone(forbidden.map { "${it.containingFile.relativePath()}:${it.name}" })
    }

    @Test
    fun `models and repositories do not import HTTP payloads`() {
        val invalid = production.files.filter { it.featureLayer in setOf("model", "repository") }.flatMap { file ->
            file.imports.filter {
                it.name.startsWith("$ROOT_PACKAGE.") && it.name.split('.').windowed(2).any { path ->
                    path == WEB_PAYLOAD
                }
            }
                .map { "${file.relativePath()} ${it.name}" }
        }
        assertNone(invalid)
    }

    @Test
    fun `metrics classes live in monitoring`() {
        val invalid = production.classes().filter {
            it.name.endsWith("Metrics") && !it.containingFile.inLayer("monitoring")
        }
        assertNone(invalid.map { "${it.containingFile.relativePath()}:${it.name}" })
    }

    @Test
    fun `jOOQ repositories implement the interface named after the repository`() {
        val invalid = production.classes().filter { it.name.startsWith("Jooq") && it.name.endsWith("Repository") }.filter { clazz ->
            clazz.parents(indirectParents = true).none {
                it.sourceDeclaration?.asInterfaceDeclaration()?.name == clazz.name.removePrefix("Jooq")
            }
        }
        assertNone(invalid.map { "${it.containingFile.relativePath()}:${it.name}" })
    }

    private val KoFileDeclaration.packageParts: List<String>?
        get() {
            val name = packagee?.name ?: return null
            return when {
                name == ROOT_PACKAGE -> emptyList()
                name.startsWith("$ROOT_PACKAGE.") -> name.removePrefix("$ROOT_PACKAGE.").split('.')
                else -> null
            }
        }

    private val KoFileDeclaration.featureLayer: String?
        get() = packageParts?.takeUnless { it.firstOrNull() in setOf("infrastructure", "shared") }?.getOrNull(1)

    private fun KoFileDeclaration.inLayer(layer: String): Boolean {
        val parts = packageParts.orEmpty()
        return if (parts.firstOrNull() in setOf("infrastructure", "shared")) {
            layer in parts.drop(1)
        } else {
            featureLayer == layer
        }
    }

    private val KoFileDeclaration.inWebPayload: Boolean
        get() = packageParts?.windowed(2)?.any { it == WEB_PAYLOAD } == true

    private fun KoFileDeclaration.relativePath(): String = File(path).canonicalFile.relativeTo(repository).invariantSeparatorsPath

    private fun assertNone(violations: List<String>) {
        assertEquals(emptyList<String>(), violations.sorted(), violations.sorted().joinToString("\n"))
    }

    private companion object {
        const val ROOT_PACKAGE = "com.andrewtinyakov.messenger"
        val FEATURE_LAYERS = setOf("config", "model", "repository", "service", "scheduling", "monitoring", "messaging", "grpc")
        val WEB_PAYLOAD = listOf("web", "payload")
        val SCHEDULED_ANNOTATIONS = setOf(
            "org.springframework.scheduling.annotation.Scheduled",
            "org.springframework.scheduling.annotation.Schedules",
        )
        val TRANSACTIONAL_ANNOTATIONS = setOf(
            "org.springframework.transaction.annotation.Transactional",
            "jakarta.transaction.Transactional",
            "javax.transaction.Transactional",
        )
    }
}
