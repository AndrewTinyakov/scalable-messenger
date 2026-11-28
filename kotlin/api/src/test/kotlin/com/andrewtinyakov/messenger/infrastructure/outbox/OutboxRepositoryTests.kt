package com.andrewtinyakov.messenger.infrastructure.outbox

import com.andrewtinyakov.messenger.infrastructure.database.PostgresStatements
import com.andrewtinyakov.messenger.infrastructure.database.generated.Tables.MESSENGER_OUTBOX_EVENTS
import com.andrewtinyakov.messenger.infrastructure.database.generated.enums.RoomKind
import com.andrewtinyakov.messenger.infrastructure.database.postgresFunction
import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import com.andrewtinyakov.messenger.shared.id.newId
import org.jooq.impl.DSL
import org.jooq.impl.SQLDataType.OTHER
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
            val triggers = DSL.table(DSL.name("pg_catalog", "pg_trigger"))
            val relation = DSL.field(DSL.name("tgrelid"), OTHER)
            val outboxRelation = postgresFunction("to_regclass", OTHER, DSL.inline(MESSENGER_OUTBOX_EVENTS.name))
            assertEquals(0, db.fetchCount(triggers, relation.eq(outboxRelation)))
            dataSource.connection.use { connection ->
                connection.autoCommit = true
                PostgresStatements.execute(connection, PostgresStatements.listen(DSL.name(OUTBOX_WAKEUP_CHANNEL)))
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
                assertEquals(0, db.fetchCount(MESSENGER_OUTBOX_EVENTS, MESSENGER_OUTBOX_EVENTS.ID.eq(id.value)))
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
                RoomKind.USER,
                db.select(MESSENGER_OUTBOX_EVENTS.ROOM_KIND).from(MESSENGER_OUTBOX_EVENTS)
                    .where(MESSENGER_OUTBOX_EVENTS.ID.eq(userEvent.value)).fetchSingle().value1(),
            )
            assertEquals(
                RoomKind.GROUP,
                db.select(MESSENGER_OUTBOX_EVENTS.ROOM_KIND).from(MESSENGER_OUTBOX_EVENTS)
                    .where(MESSENGER_OUTBOX_EVENTS.ID.eq(groupEvent.value)).fetchSingle().value1(),
            )

            db.update(MESSENGER_OUTBOX_EVENTS).set(MESSENGER_OUTBOX_EVENTS.ROOM, "group:${newId()}")
                .where(MESSENGER_OUTBOX_EVENTS.ID.eq(userEvent.value)).execute()

            assertEquals(
                RoomKind.GROUP,
                db.select(MESSENGER_OUTBOX_EVENTS.ROOM_KIND).from(MESSENGER_OUTBOX_EVENTS)
                    .where(MESSENGER_OUTBOX_EVENTS.ID.eq(userEvent.value)).fetchSingle().value1(),
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
                    db.fetchCount(MESSENGER_OUTBOX_EVENTS, MESSENGER_OUTBOX_EVENTS.ID.`in`(validEvent.value, invalidEvent.value)),
                )
            }
        }
    }
