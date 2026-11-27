package com.andrewtinyakov.messenger.rulefixture.model

class ErasedModel {
    fun isAbsent(): Boolean {
        val value: com.andrewtinyakov.messenger.rulefixture.web.payload.ProbePayload? = null
        return value == null
    }
}
