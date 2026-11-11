package com.andrewtinyakov.messenger.message.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.service.SendStatusService
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesRequest
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesResponse
import com.andrewtinyakov.messenger.shared.id.requireId
import jakarta.validation.Valid
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/sends")
class SendStatusController(
    private val sendStatusService: SendStatusService,
) {
    @GetMapping("/{requestId}")
    fun status(
        session: AuthenticatedSession,
        @PathVariable requestId: String,
    ): SendStatusResponse = sendStatusService.status(userId = session.userId, requestId = RequestId(requireId(requestId)))

    @PostMapping("/status")
    fun statuses(
        session: AuthenticatedSession,
        @Valid @RequestBody request: SendStatusesRequest,
    ): SendStatusesResponse = sendStatusService.statuses(
        userId = session.userId,
        requestIds = request.requestIds.map {
            RequestId(requireId(it))
        },
    )
}
