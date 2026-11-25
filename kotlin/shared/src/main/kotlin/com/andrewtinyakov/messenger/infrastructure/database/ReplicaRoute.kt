package com.andrewtinyakov.messenger.infrastructure.database

interface ReplicaRoute {
    fun available(): Boolean

    fun <T> on(block: () -> T): T
}
