package com.andrewtinyakov.messenger.chat.deletion.config

import org.springframework.boot.context.properties.ConfigurationProperties

@ConfigurationProperties("messenger.deletion.purge")
data class HistoryPurgeProperties(
    val batchSize: Int = 500,
    val maxBatchesPerRun: Int = 4,
    val personalCleanupBatchSize: Int = 500,
    val personalCleanupBatchesPerRun: Int = 2,
) {
    init {
        require(batchSize in 1..1000) { "History purge batch size must be between 1 and 1000" }
        require(maxBatchesPerRun > 0) { "History purge maximum batches per run must be positive" }
        require(personalCleanupBatchSize in 1..1000) { "Personal cleanup batch size must be between 1 and 1000" }
        require(personalCleanupBatchesPerRun > 0) { "Personal cleanup batches per run must be positive" }
    }
}
