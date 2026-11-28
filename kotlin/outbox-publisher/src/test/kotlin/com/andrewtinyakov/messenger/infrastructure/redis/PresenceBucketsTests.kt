package com.andrewtinyakov.messenger.infrastructure.redis

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertFalse
import org.junit.jupiter.api.Test
import tools.jackson.core.type.TypeReference
import tools.jackson.databind.json.JsonMapper
import java.io.File

class PresenceBucketsTests {
    @Test
    fun `UTF-8 FNV-1a presence buckets match the gateway wire vectors`() {
        val fixture = File("../../ws/internal/roomname/testdata/presence-buckets.json")
        val expected = JsonMapper.builder().build().readValue(fixture, object : TypeReference<Map<String, Int>>() {})
        assertFalse(expected.isEmpty())
        expected.forEach { (userId, bucket) ->
            assertEquals(bucket, PresenceBuckets.of(userId), userId)
        }
    }
}
