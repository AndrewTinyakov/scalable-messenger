package com.andrewtinyakov.messenger.auth.service

import com.andrewtinyakov.messenger.shared.MessengerIntegrationTest
import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test
import org.springframework.beans.factory.annotation.Autowired

class UserSearchServiceTests
    @Autowired
    constructor(
        private val service: UserSearchService,
    ) : MessengerIntegrationTest() {
        @Test
        fun `search finds case insensitive substrings inside usernames`() {
            user("lookup_andrew")
            user("lookup_bob")

            assertEquals(listOf("lookup_andrew"), service.search(query = "DREW").map { it.username })
        }

        @Test
        fun `search treats underscore and percent as literal characters`() {
            user("literal_ann_smith")
            user("literal_annxsmith")

            assertEquals(listOf("literal_ann_smith"), service.search(query = "ann_").map { it.username })
            assertEquals(emptyList<String>(), service.search(query = "literal_%").map { it.username })
        }

        @Test
        fun `search does not interpret a backslash as a query escape`() {
            user("escape_trigram")

            assertEquals(emptyList<String>(), service.search(query = "\\trigram").map { it.username })
        }

        @Test
        fun `search retains alphabetical ordering and a bounded result for short or empty input`() {
            (0..34).reversed().forEach { user("bounded_search_${it.toString().padStart(2, '0')}") }

            assertEquals(
                (0..29).map { "bounded_search_${it.toString().padStart(2, '0')}" },
                service.search(query = "bounded_search").map { it.username },
            )
            val emptyQuery = service.search(query = "").map { it.username }
            assertEquals(30, emptyQuery.size)
            assertEquals(emptyQuery.sorted(), emptyQuery)
        }
    }
