package com.andrewtinyakov.messenger.chat.grpc

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse
import com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizePresenceResponse
import com.andrewtinyakov.messenger.generated.grpc.ChatAuthorizationGrpc
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.id.ChatId
import com.andrewtinyakov.messenger.shared.id.SessionId
import com.andrewtinyakov.messenger.shared.id.UserId
import com.andrewtinyakov.messenger.shared.id.requireId
import com.andrewtinyakov.messenger.shared.web.ApiException
import io.grpc.Status
import io.grpc.StatusRuntimeException
import io.grpc.stub.StreamObserver
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.OffsetDateTime

@Component
class ChatAuthorizationGrpcService(
    private val sessionRepository: SessionRepository,
    private val clock: Clock,
    private val groupAuthorizationRepository: GroupAuthorizationRepository,
    private val presenceAuthorizationRepository: PresenceAuthorizationRepository,
    private val sidebarAuthorizationRepository: SidebarAuthorizationRepository,
) : ChatAuthorizationGrpc.ChatAuthorizationImplBase() {
    override fun authorizeSidebar(
        request: com.andrewtinyakov.messenger.generated.grpc.AuthorizeSidebarRequest,
        responseObserver: StreamObserver<com.andrewtinyakov.messenger.generated.grpc.AuthorizeSidebarResponse>,
    ) = respond(responseObserver) {
        val ids = request.chatIdsList
        if (ids.size > 100 ||
            ids.size != ids.toSet().size
        ) {
            throw Status.INVALID_ARGUMENT.withDescription("Provide at most 100 distinct chats").asRuntimeException()
        }
        val chats =
            sidebarAuthorizationRepository.authorize(
                requireSessionId(request.sessionId),
                ids.map(::requireChatId),
                OffsetDateTime.now(clock),
            )
                ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()
        com.andrewtinyakov.messenger.generated.grpc.AuthorizeSidebarResponse.newBuilder().addAllChats(
            chats.map {
                com.andrewtinyakov.messenger.generated.grpc.SidebarChat.newBuilder().setChatId(
                    it.chatId.value,
                ).setPeerId(it.peerId?.value ?: "").setGroup(it.group).build()
            },
        ).build()
    }

    override fun validateSession(request: ValidateSessionRequest, responseObserver: StreamObserver<ValidateSessionResponse>) =
        respond(responseObserver) {
            val session = requireSession(request.sessionId)
            ValidateSessionResponse.newBuilder()
                .setUserId(session.userId.value)
                .setDeviceId(session.deviceId.value)
                .setSessionId(session.sessionId.value)
                .build()
        }

    override fun authorizeGroup(request: AuthorizeGroupRequest, responseObserver: StreamObserver<AuthorizeGroupResponse>) =
        respond(responseObserver) {
            val sessionId = requireSessionId(request.sessionId)
            val parsedChatId = runCatching { requireChatId(request.chatId) }
            val authorization = requireGroupAuthorization(sessionId = sessionId, chatIds = listOfNotNull(parsedChatId.getOrNull()))
            val chatId = parsedChatId.getOrThrow()
            if (chatId !in authorization.authorizedChatIds) {
                throw Status.PERMISSION_DENIED.withDescription("Not a group member").asRuntimeException()
            }
            AuthorizeGroupResponse.newBuilder().setRoom(RoomAddress.group(chatId)).build()
        }

    override fun authorizeGroups(request: AuthorizeGroupsRequest, responseObserver: StreamObserver<AuthorizeGroupsResponse>) =
        respond(responseObserver) {
            val ids = request.chatIdsList
            if (ids.size !in 1..10 || ids.size != ids.toSet().size) {
                throw Status.INVALID_ARGUMENT.withDescription("Provide 1 to 10 distinct chat IDs").asRuntimeException()
            }
            val chatIds = ids.map(::requireChatId)
            val authorization = requireGroupAuthorization(sessionId = requireSessionId(request.sessionId), chatIds = chatIds)
            val allowed = authorization.authorizedChatIds
            AuthorizeGroupsResponse.newBuilder().addAllAuthorizedChatIds(chatIds.filter(allowed::contains).map { it.value }).build()
        }

    override fun authorizePresence(request: AuthorizePresenceRequest, responseObserver: StreamObserver<AuthorizePresenceResponse>) =
        respond(responseObserver) {
            val ids = request.userIdsList
            if (ids.size !in 1..100 || ids.size != ids.toSet().size) {
                throw Status.INVALID_ARGUMENT.withDescription("Provide 1 to 100 distinct peers").asRuntimeException()
            }
            val chatId = requireChatId(request.chatId)
            val peers = ids.map(::requireUserId)
            val allowed = presenceAuthorizationRepository.authorizedPeers(
                requireSessionId(request.sessionId),
                chatId,
                peers,
                OffsetDateTime.now(clock),
            ) ?: throw Status.PERMISSION_DENIED.withDescription("Presence access denied").asRuntimeException()
            AuthorizePresenceResponse.newBuilder().addAllAuthorizedUserIds(peers.filter(allowed::contains).map(UserId::value)).build()
        }

    private fun requireSession(value: String): AuthenticatedSession =
        sessionRepository.findSession(sessionId = requireSessionId(value), now = OffsetDateTime.now(clock))
            ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()

    private fun requireGroupAuthorization(sessionId: SessionId, chatIds: List<ChatId>): GroupAuthorization =
        groupAuthorizationRepository.findAuthorization(sessionId = sessionId, now = OffsetDateTime.now(clock), chatIds = chatIds)
            ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()

    private fun requireSessionId(value: String): SessionId {
        if (!Regex("[0-9a-f]{64}").matches(value)) {
            throw Status.UNAUTHENTICATED.withDescription("Invalid session ID").asRuntimeException()
        }
        return SessionId(value)
    }

    private fun requireUserId(value: String): UserId {
        try {
            return UserId(requireId(value))
        } catch (_: ApiException) {
            throw Status.INVALID_ARGUMENT.withDescription("Invalid user ID").asRuntimeException()
        }
    }

    private fun requireChatId(value: String): ChatId {
        try {
            return ChatId(requireId(value))
        } catch (_: ApiException) {
            throw Status.INVALID_ARGUMENT.withDescription("Invalid chat ID").asRuntimeException()
        }
    }

    private fun <T> respond(observer: StreamObserver<T>, action: () -> T) {
        val response = try {
            action()
        } catch (error: StatusRuntimeException) {
            observer.onError(error)
            return
        } catch (_: Exception) {
            observer.onError(Status.UNAVAILABLE.withDescription("Authorization store unavailable").asRuntimeException())
            return
        }
        observer.onNext(response)
        observer.onCompleted()
    }
}
