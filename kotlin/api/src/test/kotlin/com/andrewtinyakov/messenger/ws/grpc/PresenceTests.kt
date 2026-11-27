package com.andrewtinyakov.messenger.ws.grpc

import com.andrewtinyakov.messenger.auth.service.AuthenticationService
import com.andrewtinyakov.messenger.chat.model.ChatId
import com.andrewtinyakov.messenger.chat.service.ChatMembershipService
import com.andrewtinyakov.messenger.chat.service.ChatService
import com.andrewtinyakov.messenger.deletion.model.DeletionScope
import com.andrewtinyakov.messenger.deletion.service.DeletionService
import com.andrewtinyakov.messenger.generated.grpc.LastSeen
import com.andrewtinyakov.messenger.generated.grpc.OnlineCountMembersRequest
import com.andrewtinyakov.messenger.generated.grpc.OnlineCountMembersResponse
import com.andrewtinyakov.messenger.generated.grpc.PresenceLevel
import com.andrewtinyakov.messenger.generated.grpc.PresenceVisibilityRequest
import com.andrewtinyakov.messenger.generated.grpc.PresenceVisibilityResponse
import com.andrewtinyakov.messenger.generated.grpc.RecordLastSeenRequest
import com.andrewtinyakov.messenger.generated.grpc.RecordLastSeenResponse
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import io.grpc.Status
import io.grpc.stub.StreamObserver
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import java.time.Instant
import java.time.temporal.ChronoUnit

class PresenceTests
    @Autowired
    constructor(
        private val authorization: ChatAuthorizationGrpcService,
        private val authentication: AuthenticationService,
        private val chats: ChatService,
        private val memberships: ChatMembershipService,
        private val deletion: DeletionService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `visibility is full for self and users sharing a live chat and none otherwise`() {
            val viewer = credentials()
            val member = credentials()
            val removed = credentials()
            val stranger = credentials()
            val chat = chats.createGroup(viewer.session.userId, "Presence", listOf(member, removed).map { it.session.userId })
            memberships.removeMember(ChatId(chat.id), viewer.session.userId, removed.session.userId)
            val subjects = listOf(viewer, member, removed, stranger).map { it.session.userId.value } + newId()

            val levels = visibility(viewer.session.sessionId.value, subjects).associate { it.userId to it.level }

            assertEquals(
                listOf(
                    PresenceLevel.PRESENCE_LEVEL_FULL,
                    PresenceLevel.PRESENCE_LEVEL_FULL,
                    PresenceLevel.PRESENCE_LEVEL_NONE,
                    PresenceLevel.PRESENCE_LEVEL_NONE,
                    PresenceLevel.PRESENCE_LEVEL_NONE,
                ),
                subjects.map { levels[it] },
            )
            deletion.deleteChat(ChatId(chat.id), viewer.session.userId, RequestId(chat.id), DeletionScope.EVERYONE)
            assertEquals(
                PresenceLevel.PRESENCE_LEVEL_NONE,
                visibility(viewer.session.sessionId.value, listOf(member.session.userId.value)).single().level,
            )
        }

        @Test
        fun `visibility requires a live session and bounded distinct subjects`() {
            val viewer = credentials()
            authentication.logout(viewer.token)
            assertStatus(Status.Code.UNAUTHENTICATED) { visibilityCall(viewer.session.sessionId.value, listOf(newId()), it) }
            val active = credentials().session.sessionId.value
            assertStatus(Status.Code.INVALID_ARGUMENT) { visibilityCall(active, emptyList(), it) }
            assertStatus(Status.Code.INVALID_ARGUMENT) { visibilityCall(active, List(501) { newId() }, it) }
            val repeated = newId()
            assertStatus(Status.Code.INVALID_ARGUMENT) { visibilityCall(active, listOf(repeated, repeated), it) }
        }

        @Test
        fun `last seen keeps the latest time and is returned with visibility`() {
            val viewer = credentials()
            val member = credentials()
            chats.createGroup(viewer.session.userId, "Last seen", listOf(member.session.userId))
            val later = Instant.now().truncatedTo(ChronoUnit.MILLIS)
            val earlier = later.minusSeconds(3600)

            record(member.session.userId.value to later, member.session.userId.value to earlier)
            record(member.session.userId.value to earlier)

            val seen = visibility(viewer.session.sessionId.value, listOf(member.session.userId.value)).single()
            assertEquals(later.toEpochMilli(), seen.lastSeenUnixMs)
            assertStatus(Status.Code.INVALID_ARGUMENT) {
                authorization.recordLastSeen(lastSeenRequest(member.session.userId.value to later.plusSeconds(3600)), it)
            }
        }

        @Test
        fun `online count members lists small groups and only counts large ones`() {
            val owner = credentials()
            val members = List(3) { credentials() }
            val chat = chats.createGroup(owner.session.userId, "Count", members.map { it.session.userId })
            val session = members.first().session.sessionId.value

            val small = onlineCount(session, chat.id, 10)
            assertEquals(4, small.memberCount)
            assertEquals((members + owner).map { it.session.userId.value }.sorted(), small.memberIdsList)

            val large = onlineCount(session, chat.id, 2)
            assertEquals(4, large.memberCount)
            assertEquals(emptyList<String>(), large.memberIdsList)

            memberships.removeMember(ChatId(chat.id), owner.session.userId, members.first().session.userId)
            assertStatus(Status.Code.PERMISSION_DENIED) { onlineCountCall(session, chat.id, 10, it) }
            assertStatus(Status.Code.INVALID_ARGUMENT) { onlineCountCall(session, chat.id, 201, it) }
        }

        private fun credentials() = authentication.register("presence_${newId().lowercase()}", "test-password")

        private fun visibility(session: String, users: List<String>) =
            Reply<PresenceVisibilityResponse>().also { visibilityCall(session, users, it) }
                .require().subjectsList

        private fun visibilityCall(
            session: String,
            users: List<String>,
            observer: StreamObserver<PresenceVisibilityResponse>,
        ) = authorization.presenceVisibility(
            PresenceVisibilityRequest.newBuilder().setSessionId(session).addAllUserIds(users).build(),
            observer,
        )

        private fun onlineCount(session: String, chat: String, limit: Int) =
            Reply<OnlineCountMembersResponse>().also {
                onlineCountCall(session, chat, limit, it)
            }.require()

        private fun onlineCountCall(
            session: String,
            chat: String,
            limit: Int,
            observer: StreamObserver<OnlineCountMembersResponse>,
        ) = authorization.onlineCountMembers(
            OnlineCountMembersRequest.newBuilder().setSessionId(session).setChatId(chat).setLimit(limit).build(),
            observer,
        )

        private fun record(vararg entries: Pair<String, Instant>) {
            Reply<RecordLastSeenResponse>().also {
                authorization.recordLastSeen(lastSeenRequest(*entries), it)
            }.require()
        }

        private fun lastSeenRequest(vararg entries: Pair<String, Instant>): RecordLastSeenRequest =
            RecordLastSeenRequest.newBuilder().addAllEntries(
                entries.map { (user, seen) -> LastSeen.newBuilder().setUserId(user).setSeenUnixMs(seen.toEpochMilli()).build() },
            ).build()

        private fun <T> assertStatus(code: Status.Code, call: (StreamObserver<T>) -> Unit) {
            val reply = Reply<T>()
            call(reply)
            assertEquals(code, Status.fromThrowable(reply.error).code)
        }

        private class Reply<T> : StreamObserver<T> {
            var value: T? = null
            var error: Throwable? = null

            override fun onNext(response: T) {
                value = response
            }

            override fun onError(error: Throwable) {
                this.error = error
            }

            override fun onCompleted() = Unit

            fun require(): T = value ?: throw AssertionError("gRPC call failed", error)
        }
    }
