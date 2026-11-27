package com.andrewtinyakov.messenger.checks

import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.ConstantDynamic
import org.objectweb.asm.Handle
import org.objectweb.asm.Label
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes.ASM9

internal class JooqPlainSqlScanner(
    private val jooqApi: JooqPlainSqlApi,
) {
    fun scan(classes: List<ClassReader>, includeCaller: (String) -> Boolean = { true }): List<JooqPlainSqlViolation> {
        val applicationParents = classes.associate { it.className to (listOfNotNull(it.superName) + it.interfaces) }
        return classes.filter { includeCaller(it.className) }.flatMap { scan(it, applicationParents) }
    }

    private fun scan(reader: ClassReader, parents: Map<String, List<String>>): List<JooqPlainSqlViolation> = buildList {
        reader.accept(
            object : ClassVisitor(ASM9) {
                private var sourceFile: String? = null
                private var inlineLines = emptyMap<Int, Int>()

                override fun visitSource(source: String?, debug: String?) {
                    sourceFile = source
                    inlineLines = kotlinInlineCallSites(debug)
                }

                override fun visitMethod(
                    access: Int,
                    name: String,
                    descriptor: String,
                    signature: String?,
                    exceptions: Array<out String>?,
                ): MethodVisitor = object : MethodVisitor(ASM9) {
                    private val caller = JooqMethod(reader.className, name, descriptor)
                    private var line = 0

                    override fun visitLineNumber(number: Int, start: Label) {
                        line = inlineLines[number] ?: number
                    }

                    override fun visitMethodInsn(opcode: Int, owner: String, name: String, descriptor: String, isInterface: Boolean) {
                        checkCall(JooqMethod(owner, name, descriptor))
                    }

                    override fun visitInvokeDynamicInsn(name: String, descriptor: String, bootstrap: Handle, vararg arguments: Any) {
                        checkConstant(bootstrap)
                        arguments.forEach(::checkConstant)
                    }

                    override fun visitLdcInsn(value: Any) = checkConstant(value)

                    private fun checkConstant(value: Any) {
                        when (value) {
                            is Handle -> {
                                checkCall(JooqMethod(value.owner, value.name, value.desc))
                            }

                            is ConstantDynamic -> {
                                checkConstant(value.bootstrapMethod)
                                repeat(value.bootstrapMethodArgumentCount) { checkConstant(value.getBootstrapMethodArgument(it)) }
                            }
                        }
                    }

                    private fun checkCall(target: JooqMethod) {
                        if (jooqApi.forbids(target, parents) && (caller != sqlTaggingHook || !target.isSqlTaggingMethod())) {
                            add(JooqPlainSqlViolation(caller, sourceFile, line, target))
                        }
                    }
                }
            },
            ClassReader.SKIP_FRAMES,
        )
    }

    private companion object {
        val sqlTaggingHook = JooqMethod(
            "com/andrewtinyakov/messenger/infrastructure/database/DatabaseQueryListener",
            "renderEnd",
            "(Lorg/jooq/ExecuteContext;)V",
        )
    }
}
