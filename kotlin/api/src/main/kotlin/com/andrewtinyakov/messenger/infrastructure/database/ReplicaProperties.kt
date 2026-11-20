package com.andrewtinyakov.messenger.infrastructure.database

import org.springframework.boot.context.properties.ConfigurationProperties
import org.springframework.util.unit.DataSize
import java.time.Duration

@ConfigurationProperties("messenger.database.replica")
data class ReplicaProperties(
    val url: String? = null,
    val maxLag: DataSize = DataSize.ofMegabytes(16),
    val checkInterval: Duration = Duration.ofSeconds(1),
) {
    init {
        require(!maxLag.isNegative) { "Replica lag limit must not be negative" }
        require(checkInterval.isPositive) { "Replica check interval must be positive" }
    }
}
