package com.andrewtinyakov.messenger.rulefixture.service

@org.springframework.stereotype.Service
class ErasedService {
    fun isAbsent(): Boolean {
        val value: org.jooq.DSLContext? = null
        return value == null
    }
}
