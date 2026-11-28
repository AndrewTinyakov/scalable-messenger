package com.andrewtinyakov.messenger.checks

import com.lemonappdev.konsist.api.Konsist
import com.lemonappdev.konsist.api.declaration.KoFileDeclaration
import com.lemonappdev.konsist.api.declaration.KoObjectDeclaration
import com.lemonappdev.konsist.api.declaration.combined.KoClassAndInterfaceAndObjectDeclaration
import com.lemonappdev.konsist.api.declaration.combined.KoClassAndInterfaceDeclaration
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
    fun `only sealed cases and companion objects may be nested outside web payloads`() {
        assertNone(nestedTypeViolations(scope.files))
    }

    @Test
    fun `imports and fully qualified source references respect layer boundaries`() {
        assertNone(sourceDependencyViolations(production.files))
    }

    @Test
    fun `source rules reject ordinary nested types and forbidden qualified names in fixtures`() {
        val fixtureScope = Konsist.scopeFromExternalDirectories(listOf(System.getProperty("messenger.architectureFixtureSources")))
        assertEquals(listOf("$MESSENGER_PACKAGE.rulefixture.service.ProbeService.OrdinaryNested"), nestedTypeViolations(fixtureScope.files))
        assertEquals(
            listOf(
                "ErasedModel.kt $MESSENGER_PACKAGE.rulefixture.web.payload.ProbePayload",
                "ErasedService.kt org.jooq.DSLContext",
                "ProbeModel.kt $MESSENGER_PACKAGE.rulefixture.web.payload.ProbePayload",
                "ProbeRepository.kt $MESSENGER_PACKAGE.rulefixture.web.payload.ProbePayload",
                "ProbeService.kt org.jooq.impl.DSL.selectOne",
            ),
            sourceDependencyViolations(fixtureScope.files).map { it.substringAfterLast('/') }.sorted(),
        )
    }

    private fun nestedTypeViolations(files: List<KoFileDeclaration>): List<String> = files.filterNot { it.inWebPayload }.flatMap { file ->
        file.classesAndInterfacesAndObjects(includeNested = true).filterNot { type ->
            type.isTopLevel || (type is KoObjectDeclaration && type.hasCompanionModifier) ||
                type.isSealedCase()
        }.map { it.fullyQualifiedName ?: it.name }
    }

    private fun KoClassAndInterfaceAndObjectDeclaration.isSealedCase(): Boolean {
        val enclosing = containingDeclaration as? KoClassAndInterfaceDeclaration ?: return false
        return enclosing.hasSealedModifier && parents().any { it.name in setOf(enclosing.name, enclosing.fullyQualifiedName) }
    }

    private fun sourceDependencyViolations(files: List<KoFileDeclaration>): List<String> = files.flatMap { file ->
        val parts = file.packageParts.orEmpty()
        if (listOf("service", "model", "repository").none { inLayer(parts, it) }) return@flatMap emptyList()
        qualifiedReferences(file.text)
            .filter { isForbiddenDependency(parts, it) }
            .map { "${file.relativePath()} $it" }
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
        get() = packagee?.name?.let(::messengerPackageParts)

    private fun KoFileDeclaration.inLayer(layer: String): Boolean = inLayer(packageParts.orEmpty(), layer)

    private val KoFileDeclaration.inWebPayload: Boolean
        get() = packageParts?.windowed(2)?.any { it == WEB_PAYLOAD } == true

    private fun KoFileDeclaration.relativePath(): String = File(path).canonicalFile.relativeTo(repository).invariantSeparatorsPath

    private fun assertNone(violations: List<String>) {
        assertEquals(emptyList<String>(), violations.sorted(), violations.sorted().joinToString("\n"))
    }

    private companion object {
        val FEATURE_LAYERS = setOf("config", "model", "repository", "service", "scheduling", "monitoring", "messaging", "grpc")
    }
}
