package com.andrewtinyakov.messenger.infrastructure.redis

/** The gateway's presence buckets. Must match roomname.PresenceBucketOf: FNV-1a over the UTF-8 user ID. */
internal object PresenceBuckets {
    private const val COUNT = 4096

    fun of(userId: String): Int {
        var hash = 0x811c9dc5.toInt()
        for (byte in userId.toByteArray()) {
            hash = (hash xor (byte.toInt() and 0xff)) * 0x01000193
        }
        return Integer.remainderUnsigned(hash, COUNT)
    }

    fun channel(bucket: Int): String = "messenger:{presence:$bucket}:live"
}
