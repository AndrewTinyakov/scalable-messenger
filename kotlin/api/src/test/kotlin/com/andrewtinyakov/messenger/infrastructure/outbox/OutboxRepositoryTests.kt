package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertThrows
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test
import org.postgresql.PGConnection
import org.springframework.beans.factory.annotation.Autowired
import org.springframework.dao.DataIntegrityViolationException
import org.springframework.transaction.support.TransactionTemplate
import java.sql.SQLException
import javax.sql.DataSource

class OutboxRepositoryTests
    @Autowired
    constructor(
        private val outboxRepository: OutboxRepository,
        private val transactions: TransactionTemplate,
        private val dataSource: DataSource,
    ) : MessengerIntegrationTest() {
        @Test
        fun `publishers wake after the enqueueing transaction commits, not inside it`() {
            assertEquals(
                0,
                db.queryForObject("SELECT count(*) FROM pg_trigger WHERE tgrelid = 'messenger_outbox_events'::regclass", Int::class.java),
            )
            dataSource.connection.use { connection ->
                connection.autoCommit = true
                connection.createStatement().use { it.execute("LISTEN $OUTBOX_WAKEUP_CHANNEL") }
                val listener = connection.unwrap(PGConnection::class.java)
                listener.getNotifications(200)
                val event = { OutboxMessage(EventId(newId()), "user:${newId()}", "{}") }

                transactions.execute {
                    outboxRepository.enqueue(event())
                    assertTrue(listener.getNotifications(300).isNullOrEmpty(), "Woke publishers before commit")
                }
                assertTrue(listener.getNotifications(5000).orEmpty().any { it.name == OUTBOX_WAKEUP_CHANNEL })

                transactions.execute { status ->
                    outboxRepository.enqueue(event())
                    status.setRollbackOnly()
                }
                assertTrue(listener.getNotifications(300).isNullOrEmpty(), "Woke publishers for a rolled-back enqueue")
            }
        }

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
