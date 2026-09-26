package com.andrewtinyakov.messenger.shared

import com.github.f4b6a3.ulid.UlidCreator
import java.security.MessageDigest

private val ulidPattern = Regex("[0-7][0-9A-HJKMNP-TV-Z]{25}")

fun newId(): String = UlidCreator.getUlid().toString()

fun requireId(value: String): String {
    if (!ulidPattern.matches(value)) throw ApiException(400, "INVALID_ID", "Invalid ULID")
    return value
}

fun sha256(value: String): String =
    MessageDigest.getInstance("SHA-256").digest(value.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
