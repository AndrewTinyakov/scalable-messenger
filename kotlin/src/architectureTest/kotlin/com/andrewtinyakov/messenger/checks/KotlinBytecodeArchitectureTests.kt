package com.andrewtinyakov.messenger.checks

import com.tngtech.archunit.ArchConfiguration
import com.tngtech.archunit.core.domain.JavaClass
import com.tngtech.archunit.core.importer.ClassFileImporter
import org.junit.jupiter.api.Assertions.assertAll
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import java.io.File

class KotlinBytecodeArchitectureTests {
    @Test
    fun `application classes follow resolved annotation and dependency rules`() {
        val production = classes("messenger.productionClasses")
        val tests = classes("messenger.testClasses")
        check(production.isNotEmpty() && tests.isNotEmpty())
        assertAll(
            { assertNone(serviceViolations(production)) },
            { assertNone(schedulingViolations(production)) },
            { assertNone(transactionViolations(production + tests)) },
            { assertNone(dependencyViolations(production)) },
        )
    }

    @Test
    fun `bytecode rules reject non beans and forbidden annotations and dependencies in fixtures`() {
        val fixtures = classes("messenger.architectureFixtureClasses")
        val fixturePackage = "$MESSENGER_PACKAGE.rulefixture"
        assertEquals(listOf("$fixturePackage.service.ProbeService"), serviceViolations(fixtures))
        assertEquals(listOf("$fixturePackage.service.ProbeService.tick"), schedulingViolations(fixtures))
        assertEquals(listOf("$fixturePackage.service.ProbeService.transaction"), transactionViolations(fixtures))
        assertEquals(
            listOf(
                "$fixturePackage.model.ProbeModel -> $fixturePackage.web.payload.ProbePayload",
                "$fixturePackage.repository.ProbeRepository -> $fixturePackage.web.payload.ProbePayload",
                "$fixturePackage.service.ProbeService -> org.jooq.Record1",
                "$fixturePackage.service.ProbeService -> org.jooq.SelectSelectStep",
                "$fixturePackage.service.ProbeService -> org.jooq.impl.DSL",
            ),
            dependencyViolations(fixtures),
        )
    }

    private fun serviceViolations(classes: List<JavaClass>): List<String> = classes.filter { clazz ->
        inLayer(clazz.packageParts, "service") && clazz.isTopLevelClass && !clazz.isInterface && clazz.isClassDeclaration &&
            (!clazz.simpleName.endsWith("Service") || serviceAnnotations.none(clazz::isAnnotatedWith))
    }.map { it.name }.sorted()

    private fun schedulingViolations(classes: List<JavaClass>): List<String> = classes.filterNot { clazz ->
        inLayer(clazz.packageParts, "scheduling") && clazz.simpleName.endsWith("Scheduler") &&
            clazz.isClassDeclaration && !clazz.isInterface
    }.flatMap { clazz ->
        clazz.methods.filter { method -> scheduledAnnotations.any(method::isAnnotatedWith) }.map { "${clazz.name}.${it.name}" }
    }.sorted()

    private fun transactionViolations(classes: List<JavaClass>): List<String> = classes.flatMap { clazz ->
        buildList {
            if (transactionalAnnotations.any(clazz::isAnnotatedWith)) add(clazz.name)
            for (member in clazz.members) {
                if (transactionalAnnotations.any(member::isAnnotatedWith)) add("${clazz.name}.${member.name}")
            }
        }
    }.sorted()

    private fun dependencyViolations(classes: List<JavaClass>): List<String> = classes.flatMap { clazz ->
        val parts = clazz.packageParts
        clazz.directDependenciesFromSelf.map { it.targetClass.name }.filter { isForbiddenDependency(parts, it) }
            .map { "${clazz.name} -> $it" }.distinct()
    }.sorted()

    private val JavaClass.packageParts: List<String>
        get() = messengerPackageParts(packageName).orEmpty()

    private val JavaClass.isClassDeclaration: Boolean
        get() = !isAnnotatedWith("kotlin.Metadata") || getAnnotationOfType("kotlin.Metadata").get("k").orElse(1) == 1

    private fun classes(property: String): List<JavaClass> {
        val directories = System.getProperty(property).split(File.pathSeparator).map(::File).filter(File::isDirectory)
        ArchConfiguration.get().setResolveMissingDependenciesFromClassPath(false)
        return ClassFileImporter().importPaths(directories.map(File::toPath)).toList()
    }

    private fun assertNone(violations: List<String>) = assertEquals(emptyList<String>(), violations, violations.joinToString("\n"))

    private companion object {
        val serviceAnnotations = setOf("org.springframework.stereotype.Service", "org.springframework.stereotype.Component")
        val scheduledAnnotations = setOf(
            "org.springframework.scheduling.annotation.Scheduled",
            "org.springframework.scheduling.annotation.Schedules",
        )
        val transactionalAnnotations = setOf(
            "org.springframework.transaction.annotation.Transactional",
            "jakarta.transaction.Transactional",
            "javax.transaction.Transactional",
        )
    }
}
