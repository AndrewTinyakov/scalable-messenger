package com.andrewtinyakov.messenger.message.web.controller

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesRequest
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesResponse
import jakarta.validation.Valid
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestHeader
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/sends")
class SendStatusController(
    private val auth: AuthenticationService,
    private val history: MessageHistoryService,
) {
    @GetMapping("/{requestId}")
    fun status(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @PathVariable requestId: String,
    ): SendStatusResponse = history.status(auth.session(bearer).userId, requestId)

    @PostMapping("/status")
    fun statuses(
        @RequestHeader("Authorization", required = false) bearer: String?,
        @Valid @RequestBody request: SendStatusesRequest,
    ): SendStatusesResponse = history.statuses(auth.session(bearer).userId, request.requestIds)
}
