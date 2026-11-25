package com.andrewtinyakov.messenger.deletion.model

import java.time.OffsetDateTime

data class PurgeBacklog(
    val sampledJobs: Int,
    val oldest: OffsetDateTime?,
) {
    companion object {
        const val SAMPLE_CAP = 10000
    }
}
