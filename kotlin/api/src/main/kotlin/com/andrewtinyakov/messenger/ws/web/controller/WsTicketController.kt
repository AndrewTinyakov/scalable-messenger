package com.andrewtinyakov.messenger.ws.web.controller

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.ws.service.WsTicketService
import com.andrewtinyakov.messenger.ws.web.payload.WsTicketResponse
import org.springframework.web.bind.annotation.PostMapping
import org.springframework.web.bind.annotation.RequestMapping
import org.springframework.web.bind.annotation.RestController

@RestController
@RequestMapping("/v1/auth")
class WsTicketController(
    private val wsTicketService: WsTicketService,
) {
    @PostMapping("/ws-ticket")
    fun wsTicket(
        session: AuthenticatedSession,
    ): WsTicketResponse = wsTicketService.issue(session).let { WsTicketResponse(token = it.token, expiresAt = it.expiresAt.epochSecond) }
}
