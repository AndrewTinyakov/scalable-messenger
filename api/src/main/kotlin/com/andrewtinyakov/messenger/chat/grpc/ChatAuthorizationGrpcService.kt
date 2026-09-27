package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.auth.service.WsTicketService
import com.andrewtinyakov.messenger.chat.repository.ChatRepository
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse
import com.andrewtinyakov.messenger.generated.grpc.ChatAuthorizationGrpc
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse
import com.andrewtinyakov.messenger.shared.id.requireId
import io.grpc.Status
import io.grpc.stub.StreamObserver
import org.springframework.stereotype.Component

@Component
class ChatAuthorizationGrpcService(
    private val tickets: WsTicketService,
    private val auth: AuthenticationService,
    private val chats: ChatRepository,
) : ChatAuthorizationGrpc.ChatAuthorizationImplBase() {
    override fun validateSession(request: ValidateSessionRequest, responseObserver: StreamObserver<ValidateSessionResponse>) {
        val ticket = try {
            tickets.verify(request.wsTicket)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAUTHENTICATED.withDescription("Invalid WS ticket").asRuntimeException())
            return
        }
        val active = try {
            auth.activeTicketSession(ticket.sessionId, ticket.userId, ticket.deviceId)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAVAILABLE.withDescription("Session store unavailable").asRuntimeException())
            return
        }
        if (!active) {
            responseObserver.onError(Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException())
            return
        }
        responseObserver.onNext(
            ValidateSessionResponse.newBuilder()
                .setUserId(ticket.userId)
                .setDeviceId(ticket.deviceId)
                .setSessionId(ticket.sessionId)
                .build(),
        )
        responseObserver.onCompleted()
    }

    override fun authorizeGroup(request: AuthorizeGroupRequest, responseObserver: StreamObserver<AuthorizeGroupResponse>) {
        val ticket = try {
            tickets.verify(request.wsTicket)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAUTHENTICATED.withDescription("Invalid WS ticket").asRuntimeException())
            return
        }
        val active = try {
            auth.activeTicketSession(ticket.sessionId, ticket.userId, ticket.deviceId)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAVAILABLE.withDescription("Session store unavailable").asRuntimeException())
            return
        }
        if (!active) {
            responseObserver.onError(Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException())
            return
        }
        try {
            requireId(request.chatId)
        } catch (_: Exception) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Invalid chat ID").asRuntimeException())
            return
        }
        val allowed = try {
            chats.isGroupMember(request.chatId, ticket.userId)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAVAILABLE.withDescription("Membership store unavailable").asRuntimeException())
            return
        }
        if (!allowed) {
            responseObserver.onError(Status.PERMISSION_DENIED.withDescription("Not a group member").asRuntimeException())
            return
        }
        responseObserver.onNext(AuthorizeGroupResponse.newBuilder().setRoom("group:${request.chatId}").build())
        responseObserver.onCompleted()
    }

    override fun authorizeGroups(request: AuthorizeGroupsRequest, responseObserver: StreamObserver<AuthorizeGroupsResponse>) {
        val ids = request.chatIdsList
        if (ids.size !in 1..10 || ids.size != ids.toSet().size) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Provide 1 to 10 distinct chat IDs").asRuntimeException())
            return
        }
        try {
            ids.forEach(::requireId)
        } catch (_: Exception) {
            responseObserver.onError(Status.INVALID_ARGUMENT.withDescription("Invalid chat ID").asRuntimeException())
            return
        }
        val ticket = try {
            tickets.verify(request.wsTicket)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAUTHENTICATED.withDescription("Invalid WS ticket").asRuntimeException())
            return
        }
        val active = try {
            auth.activeTicketSession(ticket.sessionId, ticket.userId, ticket.deviceId)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAVAILABLE.withDescription("Session store unavailable").asRuntimeException())
            return
        }
        if (!active) {
            responseObserver.onError(Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException())
            return
        }
        val allowed = try {
            chats.groupMemberships(ids, ticket.userId)
        } catch (_: Exception) {
            responseObserver.onError(Status.UNAVAILABLE.withDescription("Membership store unavailable").asRuntimeException())
            return
        }
        responseObserver.onNext(AuthorizeGroupsResponse.newBuilder().addAllAuthorizedChatIds(ids.filter(allowed::contains)).build())
        responseObserver.onCompleted()
    }
}
