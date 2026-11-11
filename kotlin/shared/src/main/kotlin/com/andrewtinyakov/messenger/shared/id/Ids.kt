package com.andrewtinyakov.messenger.shared.id

import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import com.github.f4b6a3.ulid.UlidCreator

private val ulidPattern = Regex("[0-7][0-9A-HJKMNP-TV-Z]{25}")

fun newId(): String = UlidCreator.getUlid().toString()

fun requireId(value: String): String {
    if (!isValidId(value)) badRequest(ApiErrorCode.INVALID_ID, "Invalid ULID")
    return value
}

fun isValidId(value: String): Boolean = ulidPattern.matches(value)
