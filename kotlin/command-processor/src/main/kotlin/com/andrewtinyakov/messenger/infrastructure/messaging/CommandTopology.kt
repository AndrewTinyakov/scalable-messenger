package com.andrewtinyakov.messenger.infrastructure.messaging

object CommandTopology {
    const val EXCHANGE = "messenger.commands"
    const val DEAD_EXCHANGE = "messenger.commands.dead"
    const val DEAD_QUEUE = "messenger.send.dead"
    const val PARTITIONS = 4
    val queues: List<String> = (0 until PARTITIONS).map { "messenger.send.$it" }

    fun route(key: String): String {
        var hash = 0x811c9dc5u
        for (byte in key.toByteArray(Charsets.UTF_8)) {
            hash = (hash xor byte.toUByte().toUInt()) * 0x01000193u
        }
        return "messenger.send.${hash % PARTITIONS.toUInt()}"
    }

    fun routeDirect(senderId: String, recipientId: String): String =
        route(listOf(senderId, recipientId).sorted().joinToString(":"))
}
