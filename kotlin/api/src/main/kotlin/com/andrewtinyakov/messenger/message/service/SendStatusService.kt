package com.andrewtinyakov.messenger.message.service

import com.andrewtinyakov.messenger.auth.model.UserId
import com.andrewtinyakov.messenger.message.model.RequestId
import com.andrewtinyakov.messenger.message.model.SendResult
import com.andrewtinyakov.messenger.message.model.SendResultStatus
import com.andrewtinyakov.messenger.message.repository.MessageRepository
import com.andrewtinyakov.messenger.message.web.payload.SendLookupStatus
import com.andrewtinyakov.messenger.message.web.payload.SendStatusEntry
import com.andrewtinyakov.messenger.message.web.payload.SendStatusResponse
import com.andrewtinyakov.messenger.message.web.payload.SendStatusesResponse
import com.andrewtinyakov.messenger.shared.web.ApiErrorCode
import com.andrewtinyakov.messenger.shared.web.badRequest
import org.springframework.stereotype.Service

@Service
class SendStatusService(
    private val repository: MessageRepository,
) {
    fun status(userId: UserId, requestId: RequestId): SendStatusResponse =
        repository.findSendResult(userId, requestId)?.toStatusResponse() ?: SendStatusResponse(SendLookupStatus.UNKNOWN)

    fun statuses(userId: UserId, requestIds: List<RequestId>): SendStatusesResponse {
        if (requestIds.size !in 1..100 ||
            requestIds.size != requestIds.toSet().size
        ) {
            badRequest(ApiErrorCode.INVALID_ID, "Provide 1 to 100 distinct request IDs")
        }
        val found = repository.findSendResults(userId, requestIds).associateBy { it.requestId }
        return SendStatusesResponse(
            requestIds.map {
                SendStatusEntry(
                    it.value,
                    found[it]?.toStatusResponse() ?: SendStatusResponse(SendLookupStatus.UNKNOWN),
                )
            },
        )
    }

    private fun SendResult.toStatusResponse(): SendStatusResponse = SendStatusResponse(
        if (status == SendResultStatus.SAVED) {
            SendLookupStatus.SAVED
        } else {
            SendLookupStatus.REJECTED
        },
        chatId?.value,
        messageId?.value,
        sequence?.toString(),
        reason,
    )
}
