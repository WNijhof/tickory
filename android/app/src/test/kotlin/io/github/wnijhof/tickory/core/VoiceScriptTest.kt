package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VoiceScriptTest {
    @Test
    fun `een herkende tekst gaat als gebeurtenis naar de pagina`() {
        assertEquals(
            "window.dispatchEvent(new CustomEvent(\"tickory-voice\",{detail:{text:\"Bel de tandarts morgen om negen uur\"}}));",
            VoiceScript.result("Bel de tandarts morgen om negen uur"),
        )
    }

    @Test
    fun `lege of alleen witte tekst is niets verstaan`() {
        for (t in listOf(null, "", "  \n\t ")) {
            assertTrue(VoiceScript.result(t).contains("{error:\"no-speech\"}"))
        }
    }

    @Test
    fun `aanhalingstekens, backslashes en regeleinden kunnen niet uit de tekenreeks breken`() {
        val s = VoiceScript.result("Zeg \"hoi\" \\ en\nregel </script><!-- \u2028\u2029 \u0001")
        assertTrue(s.contains("text:\"Zeg \\\"hoi\\\" \\\\ en regel \\u003c/script>\\u003c!-- \\u2028\\u2029 \\u0001\""))
        assertFalse(s.contains("</script>"))
        assertFalse(s.contains('\n'))
    }

    @Test
    fun `de tekst is begrensd`() {
        val s = VoiceScript.result("x".repeat(10_000))
        assertTrue(s.length < 4_200)
    }

    @Test
    fun `foutcodes zijn een vaste lijst`() {
        assertTrue(VoiceScript.error("unavailable").contains("{error:\"unavailable\"}"))
        assertTrue(VoiceScript.error("cancelled").contains("{error:\"cancelled\"}"))
        assertTrue(VoiceScript.error("\"});alert(1);").contains("{error:\"error\"}"))
    }
}
