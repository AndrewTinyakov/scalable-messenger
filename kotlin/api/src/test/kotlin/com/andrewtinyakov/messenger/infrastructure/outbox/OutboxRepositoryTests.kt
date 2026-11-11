package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.outbox.model.EventId
import com.andrewtinyakov.messenger.infrastructure.outbox.model.OutboxMessage
import com.andrewtinyakov.messenger.infrastructure.outbox.repository.OutboxRepository
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.dao.DataIntegrityViolationException
import java.sql.SQLException

class OutboxRepositoryTests
    @Autowired
    constructor(
        private val outboxRepository: OutboxRepository,
    ) : MessengerIntegrationTest() {
        @Test
        fun `durable outbox rejects message and quote content`() {
            for (field in listOf("body", "replyBody")) {
                val id = EventId(newId())
                assertThrows(DataIntegrityViolationException::class.java) {
                    outboxRepository.enqueue(listOf(OutboxMessage(id, "user:${newId()}", """{"$field":"retained content"}""")))
                }
                assertEquals(0, db.queryForObject("SELECT count(*) FROM messenger_outbox_events WHERE id=?", Int::class.java, id.value))
            }
        }

        @Test
        fun `room kind follows the room address`() {
            val userEvent = EventId(newId())
            val groupEvent = EventId(newId())
            outboxRepository.enqueue(
                listOf(
                    OutboxMessage(userEvent, "user:${newId()}", "{}"),
                    OutboxMessage(groupEvent, "group:${newId()}", "{}"),
                ),
            )

            assertEquals(
                "USER",
                db.queryForObject("SELECT room_kind::text FROM messenger_outbox_events WHERE id=?", String::class.java, userEvent.value),
            )
            assertEquals(
                "GROUP",
                db.queryForObject("SELECT room_kind::text FROM messenger_outbox_events WHERE id=?", String::class.java, groupEvent.value),
            )

            db.update("UPDATE messenger_outbox_events SET room=? WHERE id=?", "group:${newId()}", userEvent.value)

            assertEquals(
                "GROUP",
                db.queryForObject("SELECT room_kind::text FROM messenger_outbox_events WHERE id=?", String::class.java, userEvent.value),
            )
        }

        @Test
        fun `unknown room prefixes reject the entire enqueue batch`() {
            listOf("groupp:", "usr:").forEach { prefix ->
                val validEvent = EventId(newId())
                val invalidEvent = EventId(newId())

                val failure = assertThrows(DataIntegrityViolationException::class.java) {
                    outboxRepository.enqueue(
                        listOf(
                            OutboxMessage(validEvent, "user:${newId()}", "{}"),
                            OutboxMessage(invalidEvent, "$prefix${newId()}", "{}"),
                        ),
                    )
                }

                assertEquals("23502", (failure.mostSpecificCause as SQLException).sqlState)
                assertEquals(
                    0,
                    db.queryForObject(
                        "SELECT count(*) FROM messenger_outbox_events WHERE id IN (?, ?)",
                        Int::class.java,
                        validEvent.value,
                        invalidEvent.value,
                    ),
                )
            }
        }
    }
