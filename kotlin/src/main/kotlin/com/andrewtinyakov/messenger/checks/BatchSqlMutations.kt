package com.andrewtinyakov.messenger.checks

import org.objectweb.asm.Opcodes
import org.objectweb.asm.tree.AbstractInsnNode
import org.objectweb.asm.tree.MethodInsnNode
import org.objectweb.asm.tree.MethodNode
import org.objectweb.asm.tree.analysis.Analyzer
import org.objectweb.asm.tree.analysis.SourceInterpreter
import org.objectweb.asm.tree.analysis.SourceValue

internal fun batchSqlMutations(
    owner: String,
    method: MethodNode,
    batchReads: Map<MethodInsnNode, JooqPlainSqlViolation>,
): Set<JooqPlainSqlViolation> = buildSet {
    Analyzer(object : SourceInterpreter(Opcodes.ASM9) {
        override fun copyOperation(insn: AbstractInsnNode, value: SourceValue): SourceValue = value

        override fun unaryOperation(insn: AbstractInsnNode, value: SourceValue): SourceValue? {
            if (insn.opcode in setOf(Opcodes.PUTSTATIC, Opcodes.ARETURN, Opcodes.ATHROW)) record(value)
            return if (insn.opcode == Opcodes.CHECKCAST) value else super.unaryOperation(insn, value)
        }

        override fun binaryOperation(insn: AbstractInsnNode, first: SourceValue, second: SourceValue): SourceValue? {
            if (insn.opcode == Opcodes.PUTFIELD) record(second)
            return super.binaryOperation(insn, first, second)
        }

        override fun ternaryOperation(insn: AbstractInsnNode, array: SourceValue, index: SourceValue, value: SourceValue): SourceValue? {
            if (insn.opcode == Opcodes.AASTORE) {
                record(array)
                record(value)
            }
            return super.ternaryOperation(insn, array, index, value)
        }

        override fun naryOperation(insn: AbstractInsnNode, values: List<SourceValue>): SourceValue? {
            if (!isReadOnlyCall(insn)) values.forEach(::record)
            return super.naryOperation(insn, values)
        }

        private fun record(value: SourceValue) {
            value.insns.filterIsInstance<MethodInsnNode>().mapNotNullTo(this@buildSet) { batchReads[it] }
        }
    }).analyze(owner, method)
}

private fun isReadOnlyCall(insn: AbstractInsnNode): Boolean = insn is MethodInsnNode &&
    when (insn.owner) {
        "[Ljava/lang/String;", "java/lang/Object" -> insn.name == "clone" && insn.desc == "()Ljava/lang/Object;"
        "java/util/Arrays" -> insn.name in arrayReadMethods
        "kotlin/jvm/internal/Intrinsics" -> insn.name.startsWith("checkNotNull")
        else -> false
    }

private val arrayReadMethods = setOf(
    "copyOf",
    "copyOfRange",
    "toString",
    "deepToString",
    "hashCode",
    "deepHashCode",
    "equals",
    "deepEquals",
)
