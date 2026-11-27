package com.andrewtinyakov.messenger.checks

import org.objectweb.asm.AnnotationVisitor
import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes.ASM9
import java.io.File
import java.util.jar.JarFile

internal class JooqPlainSqlApi(
    jooqJar: File,
) {
    private val types = JarFile(jooqJar).use { jar ->
        jar.entries().asSequence()
            .filter { it.name.startsWith("org/jooq/") && it.name.endsWith(".class") }
            .map { entry -> jar.getInputStream(entry).use { ClassReader(it) } }
            .associate { it.className to readType(it) }
    }

    private val cache = mutableMapOf<JooqMethod, Boolean>()

    init {
        check(types["org/jooq/DSLContext"]?.plainMethods?.isNotEmpty() == true) {
            "No @PlainSQL methods found in ${jooqJar.name}"
        }
    }

    fun forbids(method: JooqMethod, applicationParents: Map<String, List<String>>): Boolean =
        if (method.owner.startsWith("org/jooq/")) {
            cache.getOrPut(method) { isForbiddenLibraryMethod(method) }
        } else {
            method.name != "<init>" && applicationParents[method.owner].orEmpty().any {
                forbids(method.copy(owner = it), applicationParents)
            }
        }

    private fun isForbiddenLibraryMethod(method: JooqMethod): Boolean {
        val type = types[method.owner] ?: return false
        return type.plainSql || method in type.plainMethods || method.isSqlTaggingMethod() ||
            (method.owner == "org/jooq/Parser" && method.name.startsWith("parse") && method.descriptor.startsWith("(Ljava/lang/String;")) ||
            (method.owner == "org/jooq/Context" && method.name == "sql") ||
            (method.name != "<init>" && type.parents.any { forbids(method.copy(owner = it), emptyMap()) })
    }

    private fun readType(reader: ClassReader): JooqType {
        var plainSql = false
        val methods = mutableSetOf<JooqMethod>()
        reader.accept(
            object : ClassVisitor(ASM9) {
                override fun visitAnnotation(descriptor: String, visible: Boolean): AnnotationVisitor? {
                    if (descriptor == annotation) plainSql = true
                    return null
                }

                override fun visitMethod(
                    access: Int,
                    name: String,
                    descriptor: String,
                    signature: String?,
                    exceptions: Array<out String>?,
                ): MethodVisitor = object : MethodVisitor(ASM9) {
                    override fun visitAnnotation(annotationDescriptor: String, visible: Boolean): AnnotationVisitor? {
                        if (annotationDescriptor == annotation) methods += JooqMethod(reader.className, name, descriptor)
                        return null
                    }
                }
            },
            ClassReader.SKIP_CODE or ClassReader.SKIP_DEBUG or ClassReader.SKIP_FRAMES,
        )
        return JooqType(listOfNotNull(reader.superName) + reader.interfaces, plainSql, methods)
    }

    private companion object {
        const val annotation = "Lorg/jooq/PlainSQL;"
    }
}
