package com.andrewtinyakov.messenger.checks

import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.Opcodes.ASM9
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
    val classDirectories = classReaders.toMap()
    val sourceDirectories = classReaders.groupBy({ it.first.className }, { it.second })
    val findings = scanner.scan(classReaders.map { it.first }) {
        !isGeneratedJooqClass(repository, classDirectories.getValue(it), it)
    }.map { finding ->
        val sourcePath = sourcePath(repository, sourceDirectories.getValue(finding.caller.owner), finding)
        "$sourcePath:${finding.line}: ${finding.caller.name} calls forbidden SQL API ${finding.target.owner}.${finding.target.name}"
    }.distinct().sorted()
    check(findings.isEmpty()) { findings.joinToString("\n", prefix = "Forbidden SQL calls:\n") }
}

private fun sourcePath(repository: File, outputs: List<File>, finding: JooqPlainSqlViolation): String {
    val owner = finding.caller.owner
    val file = finding.sourceFile ?: return "$owner.class"
    val packagePath = owner.substringBeforeLast('/', "")
    val source = outputs.asSequence().map { classes ->
        val language = classes.parentFile.name
        val module = classes.parentFile.parentFile.parentFile.parentFile
        val sourceRoot = if (classes.name == "sidebarBenchmark") {
            repository.resolve("tests/sidebar-benchmark/kotlin")
        } else {
            module.resolve("src/${classes.name}/$language")
        }
        sourceRoot.resolve("$packagePath/$file")
    }.firstOrNull(File::isFile)
    return source?.relativeTo(repository)?.invariantSeparatorsPath ?: "$packagePath/$file"
}

internal fun isGeneratedJooqClass(repository: File, classes: File, reader: ClassReader): Boolean {
    val shared = repository.resolve("kotlin/shared")
    if (classes.canonicalFile != shared.resolve("build/classes/java/main").canonicalFile) return false
    val generated = shared.resolve("src/generated/java").canonicalFile.toPath()
    val packagePath = reader.className.substringBeforeLast('/', "")
    val className = reader.className.substringAfterLast('/')
    var sourceName: String? = null
    var nested = false
    reader.accept(
        object : ClassVisitor(ASM9) {
            override fun visitSource(name: String?, debug: String?) {
                sourceName = name
            }

            override fun visitOuterClass(owner: String, name: String?, descriptor: String?) {
                nested = true
            }

            override fun visitInnerClass(name: String, outerName: String?, innerName: String?, access: Int) {
                if (name == reader.className && outerName != null) nested = true
            }
        },
        ClassReader.SKIP_CODE or ClassReader.SKIP_FRAMES,
    )
    val topLevelName = if (nested) className.substringBefore('$') else className
    if (sourceName != "$topLevelName.java") return false
    val source = generated.resolve(packagePath).resolve("$topLevelName.java").toFile().canonicalFile
    return source.isFile && source.toPath().startsWith(generated)
}
