package com.andrewtinyakov.messenger.auth.model

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Assertions.assertTrue
import org.junit.jupiter.api.Test

class DeviceLabelTests {
    @Test
    fun `common browser user agents produce short browser and system labels`() {
        val cases = mapOf(
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                to "Chrome on macOS",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0"
                to "Edge on Windows",
            "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0" to "Firefox on Linux",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15"
                to "Safari on macOS",
            "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0 Mobile/15E148 Safari/604.1"
                to "Chrome on iOS",
            "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1"
                to "Safari on iPadOS",
            "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0 Mobile Safari/537.36"
                to "Samsung Internet on Android",
            "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36 OPR/86.0"
                to "Opera on Android",
            "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
                to "Chrome on ChromeOS",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" to "Browser on Windows",
            "Firefox/133.0" to "Firefox",
        )

        cases.forEach { (userAgent, label) -> assertEquals(label, DeviceLabel.fromUserAgent(userAgent).value, userAgent) }
    }

    @Test
    fun `missing hostile or oversized user agents fall back to a bounded fixed vocabulary`() {
        for (userAgent in listOf(null, "", "curl/8.7.1", "<script>alert(1)</script>", "x".repeat(10_000))) {
            assertEquals("Unknown device", DeviceLabel.fromUserAgent(userAgent).value)
        }
        val padded = DeviceLabel.fromUserAgent("A".repeat(10_000) + " Firefox/133.0 (Windows)")
        assertEquals("Unknown device", padded.value)
        val longest = DeviceLabel.fromUserAgent("Mozilla/5.0 (X11; CrOS x86_64) SamsungBrowser/25.0")
        assertTrue(longest.value.length <= DeviceLabel.MAX_LENGTH)
    }
}
