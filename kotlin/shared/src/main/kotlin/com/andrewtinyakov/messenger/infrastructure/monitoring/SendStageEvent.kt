package com.andrewtinyakov.messenger.infrastructure.monitoring

import jdk.jfr.Enabled
import jdk.jfr.Event
import jdk.jfr.Name
import jdk.jfr.StackTrace

@Name("messenger.SendStage")
@Enabled(false)
@StackTrace(false)
class SendStageEvent : Event() {
    @JvmField
    var stage: String = ""

    @JvmField
    var requestId: String? = null

    @JvmField
    var eventId: String? = null
}
