package io.github.wnijhof.tickory.core

import java.util.Base64
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class AttachmentNameTest {
    @Test
    fun `gewone namen blijven zoals ze zijn, ook met accenten en spaties`() {
        for (name in listOf("foto.png", "Rekening maart – Nijhof & Zn.pdf", "café.txt", "日本語.txt", "foto (1).jpeg")) {
            assertEquals(name, AttachmentName.clean(name))
        }
    }

    @Test
    fun `padtekens en padtraversal worden onschadelijk`() {
        assertEquals("_.._etc_passwd", AttachmentName.clean("../../etc/passwd"))
        assertEquals("C__Windows_system32_cmd.exe", AttachmentName.clean("C:\\Windows\\system32\\cmd.exe"))
        assertEquals("a_b_c_d_e_f_g_h_i_j", AttachmentName.clean("a/b\\c:d*e?f\"g<h>i|j"))
        assertEquals("bijlage", AttachmentName.clean(".."))
        assertEquals("bijlage", AttachmentName.clean(null))
        assertEquals("bijlage", AttachmentName.clean("   "))
        assertEquals("hidden", AttachmentName.clean("...hidden"))
    }

    @Test
    fun `stuurtekens en tekens die de leesrichting omdraaien verdwijnen`() {
        assertEquals("abcde", AttachmentName.clean("a\u0000b\u001fc\u007fd\u0085e"))
        assertEquals("fotognp.exe", AttachmentName.clean("foto\u202egnp.exe"))
        assertEquals("regel een twee", AttachmentName.clean("regel\neen\r\ntwee"))
    }

    @Test
    fun `een los accent wordt samengevoegd`() {
        assertEquals("caf\u00e9.txt", AttachmentName.clean("cafe\u0301.txt"))
    }

    @Test
    fun `lange namen worden ingekort met behoud van de uitgang en breken geen surrogaatpaar af`() {
        val long = AttachmentName.clean("a".repeat(500) + ".pdf")
        assertEquals(AttachmentName.MAX_LENGTH, long.codePointCount(0, long.length))
        assertTrue(long.endsWith(".pdf"))
        val emoji = AttachmentName.clean("\uD83D\uDE00".repeat(300) + ".jpeg")
        assertEquals(AttachmentName.MAX_LENGTH, emoji.codePointCount(0, emoji.length))
        assertTrue(emoji.endsWith(".jpeg"))
        assertFalse(Character.isHighSurrogate(emoji.last()))
    }

    @Test
    fun `schoonmaken verandert een schone naam niet meer`() {
        val random = java.util.Random(7)
        val alphabet = listOf("a", "B", ".", " ", "/", "\\", ":", "\u0000", "\u202e", "\u00e9", "e\u0301", "\uD83D\uDE00", "_", "-", "\"", "\n")
        repeat(2000) {
            val s = (0 until random.nextInt(80)).joinToString("") { alphabet[random.nextInt(alphabet.size)] }
            val once = AttachmentName.clean(s)
            assertEquals(s, once, AttachmentName.clean(once))
            assertTrue(once.isNotEmpty())
            assertFalse(once.any { it in "\\/:*?\"<>|" || it.code < 32 })
        }
    }

    @Test
    fun `typen worden schoongemaakt, onzin wordt een onbekend type`() {
        assertEquals("image/png", AttachmentName.mime("IMAGE/PNG"))
        assertEquals("text/plain", AttachmentName.mime("text/plain; charset=utf-8"))
        for (bad in listOf(null, "", "png", "a/b/c", "text/<script>", "text/pl ain")) assertEquals(AttachmentName.OCTET_STREAM, AttachmentName.mime(bad))
    }

    @Test
    fun `wat scripts kan bevatten gaat als gewone tekst naar een andere app`() {
        for (risky in listOf("text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "application/rss+xml", "text/javascript")) {
            assertEquals(risky, "text/plain", AttachmentName.viewMime(risky))
        }
        assertEquals("application/pdf", AttachmentName.viewMime("application/pdf"))
        assertEquals("image/png", AttachmentName.viewMime("image/png"))
        assertEquals(AttachmentName.OCTET_STREAM, AttachmentName.viewMime("onzin"))
    }
}

class ShareLinkFilesTest {
    private val token = "abcdefghijklmnop0123456789"

    private fun decode(fragment: String): String = String(Base64.getUrlDecoder().decode(fragment.removePrefix("share=")), Charsets.UTF_8)

    @Test
    fun `bestanden komen met token, naam, type en grootte in het fragment`() {
        val files = listOf(ShareLink.SharedFile("foto.jpg", "image/jpeg", 1234), ShareLink.SharedFile("plan.pdf", "application/pdf", 99))
        val f = ShareLink.fragmentFor("Titel", "Tekst", files, token)!!
        assertEquals(
            "{\"title\":\"Titel\",\"text\":\"Tekst\",\"token\":\"$token\",\"files\":[{\"name\":\"foto.jpg\",\"mime\":\"image/jpeg\",\"size\":1234},{\"name\":\"plan.pdf\",\"mime\":\"application/pdf\",\"size\":99}]}",
            decode(f),
        )
        assertTrue(Regex("^share=[A-Za-z0-9_-]+$").matches(f))
    }

    @Test
    fun `alleen bestanden is genoeg om iets te delen, zonder tekst en bestanden is er niets`() {
        assertNotNull(ShareLink.fragmentFor(null, null, listOf(ShareLink.SharedFile("a.txt", "text/plain", 1)), token))
        assertNull(ShareLink.fragmentFor(null, null, emptyList(), token))
        assertNull(ShareLink.fragmentFor(" ", "\n", emptyList(), null))
    }

    @Test
    fun `een ongeldig token betekent geen bestanden`() {
        val files = listOf(ShareLink.SharedFile("a.txt", "text/plain", 1))
        for (bad in listOf(null, "", "kort", "met spatie en meer tekens erbij", "x'; alert(1) //aaaaaa")) {
            assertNull(bad, ShareLink.fragmentFor(null, null, files, bad))
            val f = ShareLink.fragmentFor("Titel", null, files, bad)!!
            assertFalse(decode(f).contains("files"))
        }
    }

    @Test
    fun `namen en typen worden schoongemaakt en hooguit twintig bestanden gaan mee`() {
        val files = List(30) { ShareLink.SharedFile("../x$it.txt", "RAAR TYPE", -5) }
        val json = decode(ShareLink.fragmentFor("t", null, files, token)!!)
        assertEquals(ShareLink.MAX_FILES, Regex("\"name\"").findAll(json).count())
        assertTrue(json.contains("\"name\":\"_x0.txt\""))
        assertTrue(json.contains("\"mime\":\"application/octet-stream\""))
        assertTrue(json.contains("\"size\":0"))
    }

    @Test
    fun `de tekst alleen werkt zoals eerst`() {
        assertEquals(ShareLink.fragmentFor("a", "b"), ShareLink.fragmentFor("a", "b", emptyList(), token))
    }
}
