package com.andrewtinyakov.messenger.infrastructure.redis

internal object PresenceBuckets {
    private const val COUNT = 4096

    fun of(userId: String): Int {
        var hash = 0x811c9dc5.toInt()
        for (byte in userId.toByteArray(Charsets.UTF_8)) {
            hash = (hash xor (byte.toInt() and 0xff)) * 0x01000193
        }
        return Integer.remainderUnsigned(hash, COUNT)
    }

    fun channel(bucket: Int): String = "messenger:{presence:$bucket}:live"
}
