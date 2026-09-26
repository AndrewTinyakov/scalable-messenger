package com.andrewtinyakov.messenger.generated.messaging.event


enum class SendRejectionReason(val value: String) {
    NOT_A_MEMBER("NOT_A_MEMBER"),
    CONVERSATION_NOT_FOUND("CONVERSATION_NOT_FOUND"),
    EMPTY_BODY("EMPTY_BODY"),
    BODY_TOO_LONG("BODY_TOO_LONG"),
    REQUEST_ID_CONFLICT("REQUEST_ID_CONFLICT"),
    PROCESSING_FAILED("PROCESSING_FAILED");
}