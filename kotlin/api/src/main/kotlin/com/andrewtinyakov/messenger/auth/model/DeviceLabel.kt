package com.andrewtinyakov.messenger.auth.model

private const val MAX_USER_AGENT_LENGTH = 512

private val browsers = listOf(
    "Edge" to listOf("Edg/", "EdgA/", "EdgiOS/"),
    "Opera" to listOf("OPR/", "OPT/", "Opera"),
    "Samsung Internet" to listOf("SamsungBrowser/"),
    "Firefox" to listOf("Firefox/", "FxiOS/"),
    "Chrome" to listOf("CriOS/", "Chrome/", "Chromium/"),
    "Safari" to listOf("Safari/"),
)

private val systems = listOf(
    "iOS" to listOf("iPhone", "iPod"),
    "iPadOS" to listOf("iPad"),
    "Android" to listOf("Android"),
    "ChromeOS" to listOf("CrOS"),
    "Windows" to listOf("Windows"),
    "macOS" to listOf("Macintosh", "Mac OS X"),
    "Linux" to listOf("Linux"),
)

private fun List<Pair<String, List<String>>>.match(userAgent: String): String? =
    firstOrNull { (_, markers) -> markers.any(userAgent::contains) }?.first

@JvmInline
value class DeviceLabel(
    val value: String,
) {
    init {
        require(value.isNotBlank() && value.length <= MAX_LENGTH) { "Invalid device label" }
    }

    companion object {
        const val MAX_LENGTH = 64
        private const val UNKNOWN = "Unknown device"

        fun fromUserAgent(userAgent: String?): DeviceLabel {
            val bounded = userAgent.orEmpty().take(MAX_USER_AGENT_LENGTH)
            val browser = browsers.match(bounded)
            val system = systems.match(bounded)
            return DeviceLabel(
                when {
                    browser != null && system != null -> "$browser on $system"
                    browser != null -> browser
                    system != null -> "Browser on $system"
                    else -> UNKNOWN
                },
            )
        }
    }
}
