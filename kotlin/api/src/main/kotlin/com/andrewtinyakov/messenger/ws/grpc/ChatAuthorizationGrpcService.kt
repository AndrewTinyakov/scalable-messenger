package com.andrewtinyakov.messenger.ws.grpc

import com.andrewtinyakov.messenger.auth.model.AuthenticatedSession
import com.andrewtinyakov.messenger.auth.model.SessionId
import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.auth.model.isValidSessionId
import com.andrewtinyakov.messenger.auth.repository.SessionRepository
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupResponse
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeGroupsResponse
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeSidebarRequest
import com.andrewtinyakov.messenger.generated.grpc.AuthorizeSidebarResponse
import com.andrewtinyakov.messenger.generated.grpc.ChatAuthorizationGrpc
import com.andrewtinyakov.messenger.generated.grpc.OnlineCountMembersRequest
import com.andrewtinyakov.messenger.generated.grpc.OnlineCountMembersResponse
import com.andrewtinyakov.messenger.generated.grpc.PresenceLevel as WirePresenceLevel
import com.andrewtinyakov.messenger.generated.grpc.PresenceVisibilityRequest
import com.andrewtinyakov.messenger.generated.grpc.PresenceVisibilityResponse
import com.andrewtinyakov.messenger.generated.grpc.RecordLastSeenRequest
import com.andrewtinyakov.messenger.generated.grpc.RecordLastSeenResponse
import com.andrewtinyakov.messenger.generated.grpc.SidebarChat
import com.andrewtinyakov.messenger.generated.grpc.SubjectVisibility
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionRequest
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionResponse
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionsRequest
import com.andrewtinyakov.messenger.generated.grpc.ValidateSessionsResponse
import com.andrewtinyakov.messenger.infrastructure.redis.RoomAddress
import com.andrewtinyakov.messenger.shared.web.ApiException
import com.andrewtinyakov.messenger.ws.model.GroupAuthorization
import com.andrewtinyakov.messenger.ws.model.LastSeen
import com.andrewtinyakov.messenger.ws.model.OnlineCountMembers
import com.andrewtinyakov.messenger.ws.model.PresenceLevel
import com.andrewtinyakov.messenger.ws.model.PresenceVisibility
import com.andrewtinyakov.messenger.ws.model.SidebarChatAuthorization
import com.andrewtinyakov.messenger.ws.repository.GroupAuthorizationRepository
import com.andrewtinyakov.messenger.ws.repository.PresenceRepository
import com.andrewtinyakov.messenger.ws.repository.SidebarAuthorizationRepository
import io.grpc.Status
import io.grpc.StatusRuntimeException
import io.grpc.stub.StreamObserver
import org.springframework.stereotype.Component
import java.time.Clock
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneOffset

private const val MAX_SESSIONS_PER_REQUEST = 100
private const val MAX_LAST_SEEN_SKEW_SECONDS = 60L

@Component
class ChatAuthorizationGrpcService(
    private val sessionRepository: SessionRepository,
    private val clock: Clock,
    private val groupAuthorizationRepository: GroupAuthorizationRepository,
    private val presenceRepository: PresenceRepository,
    private val sidebarAuthorizationRepository: SidebarAuthorizationRepository,
) : ChatAuthorizationGrpc.ChatAuthorizationImplBase() {
    override fun authorizeSidebar(
        request: AuthorizeSidebarRequest,
        responseObserver: StreamObserver<AuthorizeSidebarResponse>,
    ) = respond(responseObserver) {
        val ids = request.chatIdsList
        if (ids.size > SidebarChatAuthorization.MAX_CHATS ||
            ids.size != ids.toSet().size
        ) {
            throw Status.INVALID_ARGUMENT.withDescription("Provide at most ${SidebarChatAuthorization.MAX_CHATS} distinct chats")
                .asRuntimeException()
        }
        val chats =
            sidebarAuthorizationRepository.authorize(
                requireSessionId(request.sessionId),
                ids.map(::requireChatId),
                OffsetDateTime.now(clock),
            )
                ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()
        AuthorizeSidebarResponse.newBuilder().addAllChats(
            chats.map {
                SidebarChat.newBuilder().setChatId(
                    it.chatId.value,
                ).setPeerId(it.peerId?.value ?: "").setGroup(it.group).build()
            },
        ).build()
    }

    override fun validateSession(request: ValidateSessionRequest, responseObserver: StreamObserver<ValidateSessionResponse>) =
        respond(responseObserver) {
            requireSession(request.sessionId).toResponse()
        }

    override fun validateSessions(request: ValidateSessionsRequest, responseObserver: StreamObserver<ValidateSessionsResponse>) =
        respond(responseObserver) {
            val ids = request.sessionIdsList
            if (ids.size !in 1..MAX_SESSIONS_PER_REQUEST || ids.size != ids.toSet().size || !ids.all(::isValidSessionId)) {
                throw Status.INVALID_ARGUMENT.withDescription("Provide 1 to $MAX_SESSIONS_PER_REQUEST distinct session IDs")
                    .asRuntimeException()
            }
            val sessions = sessionRepository.findSessions(sessionIds = ids.map(::SessionId), now = OffsetDateTime.now(clock))
            ValidateSessionsResponse.newBuilder().addAllSessions(sessions.map { it.toResponse() }).build()
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
            if (ids.size !in 1..GroupAuthorization.MAX_CHATS_PER_REQUEST || ids.size != ids.toSet().size) {
                throw Status.INVALID_ARGUMENT.withDescription("Provide 1 to ${GroupAuthorization.MAX_CHATS_PER_REQUEST} distinct chat IDs")
                    .asRuntimeException()
            }
            val chatIds = ids.map(::requireChatId)
            val authorization = requireGroupAuthorization(sessionId = requireSessionId(request.sessionId), chatIds = chatIds)
            val allowed = authorization.authorizedChatIds
            AuthorizeGroupsResponse.newBuilder().addAllAuthorizedChatIds(chatIds.filter(allowed::contains).map { it.value }).build()
        }

    override fun presenceVisibility(request: PresenceVisibilityRequest, responseObserver: StreamObserver<PresenceVisibilityResponse>) =
        respond(responseObserver) {
            val ids = request.userIdsList
            if (ids.size !in 1..PresenceVisibility.MAX_SUBJECTS || ids.size != ids.toSet().size) {
                throw Status.INVALID_ARGUMENT.withDescription("Provide 1 to ${PresenceVisibility.MAX_SUBJECTS} distinct users")
                    .asRuntimeException()
            }
            val subjects = presenceRepository.presenceVisibility(
                requireSessionId(request.sessionId),
                ids.map(::requireUserId),
                OffsetDateTime.now(clock),
            ) ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()
            PresenceVisibilityResponse.newBuilder().addAllSubjects(subjects.map { it.toResponse() }).build()
        }

    override fun onlineCountMembers(request: OnlineCountMembersRequest, responseObserver: StreamObserver<OnlineCountMembersResponse>) =
        respond(responseObserver) {
            if (request.limit !in 1..OnlineCountMembers.MAX_MEMBERS) {
                throw Status.INVALID_ARGUMENT.withDescription("Limit must be 1 to ${OnlineCountMembers.MAX_MEMBERS}").asRuntimeException()
            }
            val members = presenceRepository.onlineCountMembers(
                requireSessionId(request.sessionId),
                requireChatId(request.chatId),
                request.limit,
                OffsetDateTime.now(clock),
            ) ?: throw Status.PERMISSION_DENIED.withDescription("Online count access denied").asRuntimeException()
            OnlineCountMembersResponse.newBuilder()
                .setMemberCount(members.memberCount)
                .addAllMemberIds(members.memberIds.map(UserId::value))
                .build()
        }

    override fun recordLastSeen(request: RecordLastSeenRequest, responseObserver: StreamObserver<RecordLastSeenResponse>) =
        respond(responseObserver) {
            if (request.entriesCount > LastSeen.MAX_ENTRIES) {
                throw Status.INVALID_ARGUMENT.withDescription("Provide at most ${LastSeen.MAX_ENTRIES} entries").asRuntimeException()
            }
            val latest = Instant.now(clock).plusSeconds(MAX_LAST_SEEN_SKEW_SECONDS)
            val entries = request.entriesList.map {
                val seenAt = Instant.ofEpochMilli(it.seenUnixMs)
                if (it.seenUnixMs <= 0 || seenAt.isAfter(latest)) {
                    throw Status.INVALID_ARGUMENT.withDescription("Invalid last seen time").asRuntimeException()
                }
                LastSeen(requireUserId(it.userId), seenAt.atOffset(ZoneOffset.UTC))
            }
            presenceRepository.recordLastSeen(entries)
            RecordLastSeenResponse.getDefaultInstance()
        }

    private fun PresenceVisibility.toResponse(): SubjectVisibility = SubjectVisibility.newBuilder()
        .setUserId(userId.value)
        .setLevel(
            when (level) {
                PresenceLevel.NONE -> WirePresenceLevel.PRESENCE_LEVEL_NONE
                PresenceLevel.COARSE -> WirePresenceLevel.PRESENCE_LEVEL_COARSE
                PresenceLevel.FULL -> WirePresenceLevel.PRESENCE_LEVEL_FULL
            },
        )
        .setLastSeenUnixMs(lastSeenAt?.toInstant()?.toEpochMilli() ?: 0)
        .build()

    private fun AuthenticatedSession.toResponse(): ValidateSessionResponse = ValidateSessionResponse.newBuilder()
        .setUserId(userId.value)
        .setDeviceId(deviceId.value)
        .setSessionId(sessionId.value)
        .setExpiresAtUnixSeconds(expiresAt.epochSecond)
        .build()

    private fun requireSession(value: String): AuthenticatedSession =
        sessionRepository.findSession(sessionId = requireSessionId(value), now = OffsetDateTime.now(clock))
            ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()

    private fun requireGroupAuthorization(sessionId: SessionId, chatIds: List<ChatId>): GroupAuthorization =
        groupAuthorizationRepository.findAuthorization(sessionId = sessionId, now = OffsetDateTime.now(clock), chatIds = chatIds)
            ?: throw Status.UNAUTHENTICATED.withDescription("Session expired or revoked").asRuntimeException()

    private fun requireSessionId(value: String): SessionId {
        if (!isValidSessionId(value)) {
            throw Status.UNAUTHENTICATED.withDescription("Invalid session ID").asRuntimeException()
        }
        return SessionId(value)
    }

    private fun requireUserId(value: String): UserId {
        try {
            return UserId.parse(value)
        } catch (_: ApiException) {
            throw Status.INVALID_ARGUMENT.withDescription("Invalid user ID").asRuntimeException()
        }
    }

    private fun requireChatId(value: String): ChatId {
        try {
            return ChatId.parse(value)
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
