package com.andrewtinyakov.messenger.checks

import org.objectweb.asm.ClassReader
import java.io.File

fun main(args: Array<String>) {
    val scanner = JooqPlainSqlScanner(JooqPlainSqlApi(File(args[0])))
    val repository = File(args[1])
    val classes = args.drop(2).map(::File)
    check(classes.isNotEmpty()) { "No first-party class directories to scan" }
    val classReaders = classes.flatMap { directory ->
        directory.walkTopDown().filter { it.extension == "class" }.map { file ->
            file.inputStream().use { ClassReader(it) } to directory
        }.toList()
    }
    val classDirectories = classReaders.associate { (reader, directory) -> reader.className to directory }
    val findings = scanner.scan(classReaders.map { it.first }, ::handwrittenCaller).map { finding ->
        val sourcePath = sourcePath(repository, classDirectories.getValue(finding.caller.owner), finding)
        "$sourcePath:${finding.line}: ${finding.caller.name} calls forbidden jOOQ API ${finding.target}"
    }.distinct().sorted()
    check(findings.isEmpty()) { findings.joinToString("\n", prefix = "Forbidden jOOQ SQL calls:\n") }
}

private fun sourcePath(repository: File, classes: File, finding: JooqPlainSqlViolation): String {
    val owner = finding.caller.owner
    val language = classes.parentFile.name
    val file = finding.sourceFile ?: return "$owner.class"
    val packagePath = owner.substringBeforeLast('/', "")
    val module = classes.parentFile.parentFile.parentFile.parentFile
    val sourceRoot = if (classes.name == "sidebarBenchmark") {
        repository.resolve("tests/sidebar-benchmark/kotlin")
    } else {
        module.resolve("src/${classes.name}/$language")
    }
    val source = sourceRoot.resolve("$packagePath/$file")
    return if (source.isFile) source.relativeTo(repository).invariantSeparatorsPath else "$packagePath/$file"
}

private fun handwrittenCaller(owner: String): Boolean =
    !owner.startsWith("com/andrewtinyakov/messenger/infrastructure/database/generated/") &&
        !owner.startsWith("com/andrewtinyakov/messenger/generated/messaging/")
