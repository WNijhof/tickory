package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.ServerAddress.Problem
import io.github.wnijhof.tickory.core.ServerAddress.Result
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class ServerAddressTest {
    private fun ok(input: String): Result.Ok {
        val result = ServerAddress.parse(input)
        assertTrue("'$input' hoort geldig te zijn, maar gaf $result", result is Result.Ok)
        return result as Result.Ok
    }

    private fun problem(input: String): Problem {
        val result = ServerAddress.parse(input)
        assertTrue("'$input' hoort ongeldig te zijn, maar gaf $result", result is Result.Invalid)
        return (result as Result.Invalid).problem
    }

    @Test
    fun `de voorbeelden van het instelscherm`() {
        val https = ok("https://taken.voorbeeld.nl")
        assertEquals("https://taken.voorbeeld.nl", https.origin)
        assertEquals("taken.voorbeeld.nl", https.host)
        assertTrue(https.https)
        assertFalse(https.schemeAssumed)

        val http = ok("http://192.168.1.10:8787")
        assertEquals("http://192.168.1.10:8787", http.origin)
        assertEquals("192.168.1.10", http.host)
        assertFalse(http.https)
    }

    @Test
    fun `pad, zoekdeel en fragment vervallen - alleen de oorsprong blijft`() {
        assertEquals("https://taken.voorbeeld.nl", ok("https://taken.voorbeeld.nl/").origin)
        assertEquals("https://taken.voorbeeld.nl", ok("https://taken.voorbeeld.nl/app/index.html?x=1&y=2#task=abc").origin)
        assertEquals("http://192.168.1.10:8787", ok("http://192.168.1.10:8787/een pad met spaties").origin)
        assertEquals("https://taken.voorbeeld.nl", ok("https://taken.voorbeeld.nl?x=1").origin)
        assertEquals("https://taken.voorbeeld.nl", ok("https://taken.voorbeeld.nl#top").origin)
    }

    @Test
    fun `hoofdletters, spaties eromheen en een punt aan het eind worden rechtgezet`() {
        assertEquals("https://taken.voorbeeld.nl", ok("  HTTPS://Taken.Voorbeeld.NL  ").origin)
        assertEquals("https://taken.voorbeeld.nl", ok("https://taken.voorbeeld.nl.").origin)
        assertEquals("http://nas:8787", ok("\tHttp://NAS:8787\n").origin)
    }

    @Test
    fun `de standaardpoort valt weg, een andere poort blijft`() {
        assertEquals("https://a.nl", ok("https://a.nl:443").origin)
        assertEquals("http://a.nl", ok("http://a.nl:80/").origin)
        assertEquals("https://a.nl:80", ok("https://a.nl:80").origin)
        assertEquals("http://a.nl:443", ok("http://a.nl:443").origin)
        assertEquals("https://a.nl:8443", ok("https://a.nl:8443").origin)
        assertEquals("http://a.nl:65535", ok("http://a.nl:65535").origin)
    }

    @Test
    fun `zonder http of https ervoor nemen we https aan`() {
        val name = ok("taken.voorbeeld.nl")
        assertEquals("https://taken.voorbeeld.nl", name.origin)
        assertTrue(name.schemeAssumed)
        assertTrue(name.https)

        assertEquals("https://192.168.1.10:8787", ok("192.168.1.10:8787").origin)
        assertEquals("https://nas:8787", ok("nas:8787").origin)
        assertEquals("https://taken.voorbeeld.nl", ok("taken.voorbeeld.nl/app").origin)
    }

    @Test
    fun `alleen http en https`() {
        assertEquals(Problem.SCHEME, problem("ftp://taken.voorbeeld.nl"))
        assertEquals(Problem.SCHEME, problem("file:///etc/passwd"))
        assertEquals(Problem.SCHEME, problem("javascript://taken.voorbeeld.nl/%0aalert(1)"))
        assertEquals(Problem.SCHEME, problem("ws://taken.voorbeeld.nl"))
        assertEquals(Problem.SCHEME, problem("content://taken.voorbeeld.nl"))
        assertEquals(Problem.SCHEME, problem("://taken.voorbeeld.nl"))
        // geen "://": dan is het geen schema maar een (ongeldige) naam met poort
        assertTrue(ServerAddress.parse("javascript:alert(1)") is Result.Invalid)
        assertTrue(ServerAddress.parse("mailto:iemand@voorbeeld.nl") is Result.Invalid)
        assertTrue(ServerAddress.parse("http:/192.168.1.10") is Result.Invalid)
    }

    @Test
    fun `geen gebruikersnaam of wachtwoord in het adres`() {
        assertEquals(Problem.CREDENTIALS, problem("https://anna:geheim@taken.voorbeeld.nl"))
        assertEquals(Problem.CREDENTIALS, problem("https://anna@taken.voorbeeld.nl"))
        assertEquals(Problem.CREDENTIALS, problem("anna:geheim@taken.voorbeeld.nl"))
        assertEquals(Problem.CREDENTIALS, problem("http://@192.168.1.10"))
        // een apenstaartje in het pad is geen inlog
        assertEquals("https://taken.voorbeeld.nl", ok("https://taken.voorbeeld.nl/pad@iets").origin)
    }

    @Test
    fun `leeg`() {
        assertEquals(Problem.EMPTY, problem(""))
        assertEquals(Problem.EMPTY, problem("   "))
        assertEquals(Problem.EMPTY, problem("\n\t"))
    }

    @Test
    fun `ongeldige adressen`() {
        val bad = listOf(
            "https://", "https:///pad", "http://:8787", "http://host:99999", "http://host:0", "http://host:abc", "http://host:",
            "http://host:-1", "http://host:80:80", "https://taken voorbeeld.nl", "https://taken..voorbeeld.nl", "https://.nl",
            "https://-a.nl", "https://a-.nl", "https://taken.voorbeeld.nl\\pad", "http://[::1", "http://[::1]x", "http://[zz::1]",
            "http://[]", "http://::1", "https://a.nl:44 3", "https://ex%61mple.nl", "https://a,b.nl", "https://" + "a".repeat(64) + ".nl",
        )
        for (input in bad) assertEquals("'$input'", Problem.INVALID, problem(input))
    }

    @Test
    fun `een backslash kan de hostnaam niet verstoppen`() {
        // Browsers lezen "\" als "/": "https://goed.nl\@fout.nl" is voor een browser goed.nl. Wij keuren het hele adres af.
        assertTrue(ServerAddress.parse("https://goed.nl\\@fout.nl") is Result.Invalid)
        assertTrue(ServerAddress.parse("https://goed.nl\\.fout.nl") is Result.Invalid)
    }

    @Test
    fun `IPv6 tussen blokhaken`() {
        assertEquals("http://[fe80::1]:8787", ok("http://[FE80::1]:8787").origin)
        assertEquals("[fe80::1]", ok("http://[FE80::1]:8787").host)
        assertEquals("https://[::1]", ok("[::1]").origin)
        assertEquals("https://[2001:db8::10]", ok("https://[2001:db8::10]:443/x").origin)
    }

    @Test
    fun `namen met bijzondere tekens worden punycode`() {
        val result = ok("https://tëst.voorbeeld.nl")
        assertTrue(result.origin, result.origin.startsWith("https://xn--"))
        assertTrue(result.origin.endsWith(".voorbeeld.nl"))
        assertEquals(result.origin, ok("https://TËST.voorbeeld.nl").origin)
    }

    // ---------- oorsprong van een volledig adres (zoals de WebView die geeft) ----------

    @Test
    fun `oorsprong van een volledig adres`() {
        assertEquals("https://a.nl", ServerAddress.originOf("https://a.nl/x?y=1#task=abc"))
        assertEquals("http://192.168.1.10:8787", ServerAddress.originOf("http://192.168.1.10:8787/#task=abc"))
        assertEquals("https://a.nl", ServerAddress.originOf("HTTPS://A.NL:443/"))
        assertNull(ServerAddress.originOf(null))
        assertNull(ServerAddress.originOf(""))
        assertNull(ServerAddress.originOf("about:blank"))
        assertNull(ServerAddress.originOf("data:text/html,<p>hoi</p>"))
        assertNull(ServerAddress.originOf("blob:https://a.nl/3f0c1d2e"))
        assertNull(ServerAddress.originOf("chrome-error://chromewebdata/"))
        assertNull(ServerAddress.originOf("file:///android_asset/index.html"))
        assertNull(ServerAddress.originOf("javascript:void(0)"))
        // zonder schema is het geen volledig adres: hier nemen we niets aan
        assertNull(ServerAddress.originOf("a.nl/pad"))
    }

    @Test
    fun `zelfde oorsprong`() {
        val origin = "https://a.nl"
        assertTrue(ServerAddress.sameOrigin("https://a.nl/", origin))
        assertTrue(ServerAddress.sameOrigin("https://a.nl/#task=abc", origin))
        assertTrue(ServerAddress.sameOrigin("https://A.NL:443/pad", origin))
        assertFalse("ander schema", ServerAddress.sameOrigin("http://a.nl/", origin))
        assertFalse("andere poort", ServerAddress.sameOrigin("https://a.nl:8443/", origin))
        assertFalse("langere naam", ServerAddress.sameOrigin("https://a.nl.kwaad.com/", origin))
        assertFalse("subdomein", ServerAddress.sameOrigin("https://x.a.nl/", origin))
        assertFalse("naam als gebruikersnaam", ServerAddress.sameOrigin("https://a.nl@kwaad.com/", origin))
        assertFalse("naam in het pad", ServerAddress.sameOrigin("https://kwaad.com/https://a.nl/", origin))
        assertFalse(ServerAddress.sameOrigin("about:blank", origin))
        assertFalse(ServerAddress.sameOrigin(null, origin))
        assertFalse(ServerAddress.sameOrigin("https://a.nl/", null))
        assertFalse(ServerAddress.sameOrigin("https://a.nl/", ""))
        assertTrue(ServerAddress.sameOrigin("http://192.168.1.10:8787/", "http://192.168.1.10:8787"))
        assertFalse(ServerAddress.sameOrigin("http://192.168.1.10:8788/", "http://192.168.1.10:8787"))
        assertFalse(ServerAddress.sameOrigin("http://192.168.1.100:8787/", "http://192.168.1.10:8787"))
    }

    @Test
    fun `doorverwijzing van http naar https op dezelfde naam nemen we over, de rest niet`() {
        assertEquals("https://a.nl", ServerAddress.httpsUpgradeOf("http://a.nl", "https://a.nl/health"))
        assertEquals("https://a.nl", ServerAddress.httpsUpgradeOf("http://a.nl:8080", "https://a.nl/health"))
        assertEquals("https://a.nl:8443", ServerAddress.httpsUpgradeOf("http://a.nl", "https://a.nl:8443/health"))
        assertNull("andere naam", ServerAddress.httpsUpgradeOf("http://a.nl", "https://b.nl/health"))
        assertNull("was al https", ServerAddress.httpsUpgradeOf("https://a.nl", "https://a.nl/elders"))
        assertNull("naar http", ServerAddress.httpsUpgradeOf("http://a.nl", "http://a.nl/elders"))
        assertNull("alleen een pad", ServerAddress.httpsUpgradeOf("http://a.nl", "/health"))
        assertNull(ServerAddress.httpsUpgradeOf("http://a.nl", null))
        assertNull(ServerAddress.httpsUpgradeOf("http://a.nl", ""))
    }
}
