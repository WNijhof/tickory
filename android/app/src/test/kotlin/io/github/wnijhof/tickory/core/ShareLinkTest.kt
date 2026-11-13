package io.github.wnijhof.tickory.core

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ShareLinkTest {
    private fun decode(fragment: String): String {
        assertTrue(fragment.startsWith("share="))
        return String(Base64.getUrlDecoder().decode(fragment.removePrefix("share=")), Charsets.UTF_8)
    }

    @Test
    fun `niets te delen geeft null`() {
        assertNull(ShareLink.fragmentFor(null, null))
        assertNull(ShareLink.fragmentFor("  ", "\n\t "))
    }

    @Test
    fun `titel en tekst komen als JSON in het fragment`() {
        val f = ShareLink.fragmentFor("Fietsroute", "https://example.org/route")
        assertNotNull(f)
        assertEquals("{\"title\":\"Fietsroute\",\"text\":\"https://example.org/route\"}", decode(f!!))
    }

    @Test
    fun `aanhalingstekens, regeleinden en besturingstekens worden ontsnapt`() {
        val f = ShareLink.fragmentFor(null, "Zeg \"hoi\"\\\nregel2\u0001")!!
        assertEquals("{\"title\":\"\",\"text\":\"Zeg \\\"hoi\\\"\\\\\\nregel2\\u0001\"}", decode(f))
    }

    @Test
    fun `het fragment bevat alleen veilige tekens, ook bij vreemde invoer`() {
        val f = ShareLink.fragmentFor("<script>alert(1)</script>'; \"", "Café ☕ 日本語 😀 </script>")!!
        assertTrue(Regex("^share=[A-Za-z0-9_-]+$").matches(f))
    }

    @Test
    fun `Nederlandse tekens blijven heel`() {
        val f = ShareLink.fragmentFor("Ñandú — één café", "ëïü ĳ")!!
        assertTrue(decode(f).contains("Ñandú — één café"))
        assertTrue(decode(f).contains("ëïü ĳ"))
    }

    @Test
    fun `lange tekst wordt afgekapt`() {
        val f = ShareLink.fragmentFor("t".repeat(1000), "x".repeat(20_000))!!
        val json = decode(f)
        assertTrue(json.length < 10_000 + 400)
        assertTrue(json.contains("t".repeat(ShareLink.MAX_SUBJECT)))
        assertTrue(!json.contains("t".repeat(ShareLink.MAX_SUBJECT + 1)))
    }

    @Test
    fun `afkappen breekt geen surrogaatpaar`() {
        val text = "a".repeat(ShareLink.MAX_TEXT - 1) + "😀😀"
        val cut = ShareLink.clean(text, ShareLink.MAX_TEXT)
        assertEquals(ShareLink.MAX_TEXT - 1, cut.length)
        assertTrue(!Character.isHighSurrogate(cut.last()))
    }
}
