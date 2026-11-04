package com.andrewtinyakov.messenger.message.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.web.AUTHENTICATED_SESSION_ATTRIBUTE
import com.andrewtinyakov.messenger.message.service.MessageHistoryService
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesRequest
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesResponse
import com.andrewtinyakov.messenger.shared.id.RequestId
import com.andrewtinyakov.messenger.shared.id.requireId
import jakarta.validation.Valid
import org.springframework.web.bind.annotation.GetMapping
import org.springframework.web.bind.annotation.PathVariable
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestAttribute
import org.springframework.web.bind.annotation.RequestBody
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/sends")
class SendStatusController(
    private val messageHistoryService: MessageHistoryService,
) {
    @GetMapping("/{requestId}")
    fun status(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @PathVariable requestId: String,
    ): SendStatusResponse = messageHistoryService.status(userId = session.userId, requestId = RequestId(requireId(requestId)))

    @PostMapping("/status")
    fun statuses(
        @RequestAttribute(AUTHENTICATED_SESSION_ATTRIBUTE) session: AuthenticatedSession,
        @Valid @RequestBody request: SendStatusesRequest,
    ): SendStatusesResponse = messageHistoryService.statuses(
        userId = session.userId,
        requestIds = request.requestIds.map {
            RequestId(requireId(it))
        },
    )
}
