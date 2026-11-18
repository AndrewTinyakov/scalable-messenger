package com.andrewtinyakov.messenger.message.model

import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectionReason

internal sealed interface SendDecision {
    val request: SendRequest

    data class Repeated(
        override val request: SendRequest,
        val previousFingerprint: String,
    ) : SendDecision

    data class Rejected(
        override val request: SendRequest,
        val reason: SendRejectionReason,
    ) : SendDecision

    data class Accepted(
        override val request: SendRequest,
    ) : SendDecision
}
