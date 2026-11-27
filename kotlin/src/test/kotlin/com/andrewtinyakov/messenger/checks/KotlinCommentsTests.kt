package com.andrewtinyakov.messenger.checks

import org.junit.jupiter.api.Assertions.assertEquals
import org.junit.jupiter.api.Test

class KotlinCommentsTests {
    @Test
    fun `reports a trailing comment after code`() {
        assertEquals(listOf("build.gradle.kts:2:11: EOL_COMMENT"), comments("val a = 1\r\nval b = 2 // trailing"))
    }

    @Test
    fun `reports one token for a nested block comment`() {
        assertEquals(listOf("build.gradle.kts:1:1: BLOCK_COMMENT"), comments("/* outer /* inner */ end */"))
    }

    @Test
    fun `reports KDoc and shebangs`() {
        assertEquals(
            listOf("build.gradle.kts:1:1: SHEBANG_COMMENT", "build.gradle.kts:2:1: KDoc"),
            comments("#!/usr/bin/env kotlin\n/** type documentation */\nclass Type"),
        )
    }

    @Test
    fun `permits comment markers inside strings`() {
        val source = "val url = \"https://example.com\"\nval text = \"\"\"-- content /* inside the string */\"\"\""
        assertEquals(emptyList<String>(), comments(source))
    }

    private fun comments(source: String) = kotlinComments("build.gradle.kts", source)
}
