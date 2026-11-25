package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.generated.messaging.event.ChatCreatedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.ChatDeletedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.ChatPreferencesChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.HistoryChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MemberRemovedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.MembershipChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.PinsChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.ReadsChangedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SavedMessageReferenceV1
import com.andrewtinyakov.messenger.generated.messaging.event.SendRejectedEventV1
import com.andrewtinyakov.messenger.generated.messaging.event.SessionRevokedEventV1
import tools.jackson.databind.ObjectMapper

fun ChatCreatedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun ChatDeletedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun ChatPreferencesChangedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun HistoryChangedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun MemberRemovedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun MembershipChangedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun PinsChangedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun ReadsChangedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun SavedMessageReferenceV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun SendRejectedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

fun SessionRevokedEventV1.toOutboxMessage(mapper: ObjectMapper) = outboxMessage(eventId, room, this, mapper)

private fun outboxMessage(eventId: String, room: String, event: Any, mapper: ObjectMapper) =
    OutboxMessage(id = EventId(eventId), room = room, payload = mapper.writeValueAsString(event))
