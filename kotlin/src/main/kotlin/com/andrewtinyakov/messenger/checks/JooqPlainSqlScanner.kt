package com.andrewtinyakov.messenger.checks

import org.objectweb.asm.ClassReader
import org.objectweb.asm.ClassVisitor
import org.objectweb.asm.ConstantDynamic
import org.objectweb.asm.Handle
import org.objectweb.asm.Label
import org.objectweb.asm.MethodVisitor
import org.objectweb.asm.Opcodes.ASM9
import org.objectweb.asm.tree.MethodInsnNode
import org.objectweb.asm.tree.MethodNode

internal class JooqPlainSqlScanner(
    private val jooqApi: JooqPlainSqlApi,
) {
    fun scan(classes: List<ClassReader>, includeCaller: (ClassReader) -> Boolean = { true }): List<JooqPlainSqlViolation> {
        val applicationParents = classes.associate { it.className to (listOfNotNull(it.superName) + it.interfaces) }
        return classes.filter(includeCaller).flatMap { scan(it, applicationParents) }
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
                ): MethodVisitor {
                    val caller = JooqMethod(reader.className, name, descriptor)
                    val method = MethodNode(ASM9, access, name, descriptor, signature, exceptions)
                    return object : MethodVisitor(ASM9, method) {
                        private var line = 0
                        private val batchReads = mutableMapOf<MethodInsnNode, JooqPlainSqlViolation>()
                        private val customAccept = name == "accept" && descriptor == "(Lorg/jooq/Context;)V" &&
                            customQueryParts.any { jooqApi.inherits(caller.owner, it, parents) }

                        override fun visitLineNumber(number: Int, start: Label) {
                            super.visitLineNumber(number, start)
                            line = inlineLines[number] ?: number
                        }

                        override fun visitMethodInsn(opcode: Int, owner: String, name: String, descriptor: String, isInterface: Boolean) {
                            super.visitMethodInsn(opcode, owner, name, descriptor, isInterface)
                            val target = JooqMethod(owner, name, descriptor)
                            when {
                                caller == sqlTaggingHook && (isSqlSetter(target) || isBatchRead(target)) -> Unit

                                customAccept && target.name == "sql" && target.descriptor in customRenderSignatures &&
                                    jooqApi.inherits(target.owner, "org/jooq/Context", parents) -> Unit

                                isBatchRead(target) -> batchReads[method.instructions.last as MethodInsnNode] = violation(target)

                                else -> checkCall(target)
                            }
                        }

                        override fun visitEnd() {
                            super.visitEnd()
                            if (batchReads.isNotEmpty()) addAll(batchSqlMutations(caller.owner, method, batchReads))
                        }

                        override fun visitInvokeDynamicInsn(name: String, descriptor: String, bootstrap: Handle, vararg arguments: Any) {
                            super.visitInvokeDynamicInsn(name, descriptor, bootstrap, *arguments)
                            checkConstant(bootstrap)
                            arguments.forEach(::checkConstant)
                        }

                        override fun visitLdcInsn(value: Any) {
                            super.visitLdcInsn(value)
                            checkConstant(value)
                        }

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
                            if (isBatchRead(target) || jooqApi.forbids(target, parents) || isRawJdbc(target)) add(violation(target))
                        }

                        private fun isRawJdbc(target: JooqMethod) = caller.owner != POSTGRES_STATEMENTS && (
                            (
                                target.owner in jdbcStatements && target.name in statementSqlMethods &&
                                    target.descriptor.startsWith("(Ljava/lang/String;")
                            ) ||
                                (target.owner == "java/sql/Connection" && target.name in connectionSqlMethods) ||
                                target.owner.startsWith("org/springframework/jdbc/core/")
                        )

                        private fun violation(target: JooqMethod) = JooqPlainSqlViolation(caller, sourceFile, line, target)

                        private fun isBatchRead(target: JooqMethod) = target.name == "batchSQL" &&
                            target.descriptor == "()[Ljava/lang/String;" &&
                            jooqApi.inherits(target.owner, "org/jooq/ExecuteContext", parents)

                        private fun isSqlSetter(target: JooqMethod) =
                            target.name == "sql" && target.descriptor == "(Ljava/lang/String;)V" &&
                                jooqApi.inherits(target.owner, "org/jooq/ExecuteContext", parents)
                    }
                }
            },
            ClassReader.SKIP_FRAMES,
        )
    }

    private companion object {
        const val POSTGRES_STATEMENTS = "com/andrewtinyakov/messenger/infrastructure/database/PostgresStatements"
        val jdbcStatements = setOf("java/sql/Statement", "java/sql/PreparedStatement", "java/sql/CallableStatement")
        val statementSqlMethods = setOf("execute", "executeQuery", "executeUpdate", "executeLargeUpdate", "addBatch")
        val connectionSqlMethods = setOf("prepareStatement", "prepareCall", "nativeSQL")
        val customQueryParts = setOf("CustomField", "CustomCondition", "CustomQueryPart").map { "org/jooq/impl/$it" }
        val customRenderSignatures = setOf("(C)Lorg/jooq/Context;", "(Ljava/lang/String;)Lorg/jooq/Context;")
        val sqlTaggingHook = JooqMethod(
            "com/andrewtinyakov/messenger/infrastructure/database/DatabaseQueryListener",
            "renderEnd",
            "(Lorg/jooq/ExecuteContext;)V",
        )
    }
}
