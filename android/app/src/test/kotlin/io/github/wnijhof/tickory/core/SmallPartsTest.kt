package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey

class IdsTest {
    @Test
    fun `alleen id's uit letters, cijfers, streepje en liggend streepje`() {
        for (good in listOf("task-0001", "inbox-project", "aB3_-xYz", "x", "a".repeat(64), "AbCdEfGhIjKlMnOp")) assertTrue(good, Ids.isSafeId(good))
        val bad = listOf(null, "", "a".repeat(65), "met spatie", "a/b", "../x", "a'b", "a\"b", "a;b", "a#b", "a?b", "a&b", "a%20b", "a\nb", "é", "a.b", "<x>", "a\\b")
        for (id in bad) assertFalse("'$id'", Ids.isSafeId(id))
    }

    @Test
    fun `uuid voor voltooien is vast per melding en past bij wat de server vraagt`() {
        val uuid = Ids.completeUuid("rem-00001", "task-0001", 1794573000000)
        assertTrue(uuid, Regex("^[A-Za-z0-9_-]{8,64}$").matches(uuid))
        assertTrue(uuid.startsWith("tickory-done-"))
        assertEquals(53, uuid.length)
        // opnieuw proberen, twee keer tikken, een tweede toestel: steeds hetzelfde
        assertEquals(uuid, Ids.completeUuid("rem-00001", "task-0001", 1794573000000))
        // een andere herinnering, taak of keer: een ander uuid
        assertNotEquals(uuid, Ids.completeUuid("rem-00002", "task-0001", 1794573000000))
        assertNotEquals(uuid, Ids.completeUuid("rem-00001", "task-0002", 1794573000000))
        assertNotEquals(uuid, Ids.completeUuid("rem-00001", "task-0001", 1794573000000 + 86_400_000))
        // de scheiding tussen de delen telt mee
        assertNotEquals(Ids.completeUuid("ab", "c", 1), Ids.completeUuid("a", "bc", 1))
    }
}

class TokenCipherTest {
    private fun newKey(): SecretKey = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()

    @Test
    fun `versleutelen en weer ontsleutelen`() {
        val key = newKey()
        for (token in listOf("tky_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcdefg", "eigt_oud", "x", "met spatie en é en 😀", "a".repeat(4000))) {
            val stored = TokenCipher.encrypt(key, token)
            assertTrue(stored.startsWith("v1:"))
            assertFalse("het token staat niet leesbaar in de opslag", stored.contains(token.take(12)) && token.length >= 12)
            assertEquals(token, TokenCipher.decrypt(key, stored))
        }
    }

    @Test
    fun `twee keer hetzelfde token geeft verschillende opslag`() {
        val key = newKey()
        assertNotEquals(TokenCipher.encrypt(key, "tky_zelfde"), TokenCipher.encrypt(key, "tky_zelfde"))
    }

    @Test
    fun `een andere sleutel, geknoei of onzin geeft niets terug`() {
        val key = newKey()
        val stored = TokenCipher.encrypt(key, "tky_geheim_token_1234567890")
        assertNull("andere sleutel", TokenCipher.decrypt(newKey(), stored))

        // één teken in het midden veranderd
        val middle = stored.length / 2
        val tampered = stored.substring(0, middle) + (if (stored[middle] == 'A') 'B' else 'A') + stored.substring(middle + 1)
        assertNull("geknoei", TokenCipher.decrypt(key, tampered))

        for (junk in listOf(null, "", "v1:", "v1:AAAA", "v1:geen base64!", "tky_geheim_token_1234567890", "v2:" + stored.substring(3), stored.substring(0, stored.length - 8))) {
            assertNull("'$junk'", TokenCipher.decrypt(key, junk))
        }
    }
}

class LocalNetworkTest {
    @Test
    fun `adressen op het eigen netwerk`() {
        val local = listOf(
            "192.168.1.10", "192.168.178.1", "10.0.0.5", "10.0.2.2", "172.16.0.1", "172.31.255.254", "169.254.10.20", "100.64.0.1", "100.127.1.1",
            "[fe80::1]", "[fd12:3456:789a::1]", "[fc00::1]", "[::ffff:192.168.1.10]",
            "nas", "raspberrypi", "taken.local", "server.lan", "mijn.fritz.box", "pc.home.arpa", "TAKEN.LOCAL", "taken.local.",
        )
        for (host in local) assertTrue(host, LocalNetwork.hostLooksLocal(host))
    }

    @Test
    fun `adressen op internet of op het toestel zelf`() {
        val notLocal = listOf(
            "8.8.8.8", "1.1.1.1", "172.15.0.1", "172.32.0.1", "192.169.1.1", "100.63.0.1", "100.128.0.1", "11.0.0.1", "127.0.0.1", "999.1.1.1",
            "[2001:db8::1]", "[2a02:a45f::1]", "[::1]", "[::ffff:8.8.8.8]", "[geen-adres]",
            "taken.voorbeeld.nl", "voorbeeld.nl", "localhost", "wnijhof.github.io", "mijnlocal.nl", "local.voorbeeld.nl",
        )
        for (host in notLocal) assertFalse(host, LocalNetwork.hostLooksLocal(host))
    }

    @Test
    fun `adressen als bytes`() {
        fun v4(a: Int, b: Int, c: Int, d: Int) = byteArrayOf(a.toByte(), b.toByte(), c.toByte(), d.toByte())
        assertTrue(LocalNetwork.isLocalAddress(v4(192, 168, 0, 1)))
        assertTrue(LocalNetwork.isLocalAddress(v4(172, 20, 0, 1)))
        assertFalse(LocalNetwork.isLocalAddress(v4(93, 184, 216, 34)))
        assertFalse(LocalNetwork.isLocalAddress(ByteArray(0)))
        assertFalse(LocalNetwork.isLocalAddress(ByteArray(7)))
    }

    @Test
    fun `een naam opzoeken die niet bestaat is niet lokaal en gooit niet`() {
        assertFalse(LocalNetwork.resolvesToLocal(""))
        assertTrue(LocalNetwork.resolvesToLocal("192.168.1.10")) // letterlijk adres: er wordt niets opgezocht
        assertFalse(LocalNetwork.resolvesToLocal("8.8.8.8"))
        assertTrue(LocalNetwork.resolvesToLocal("[fe80::1]"))
    }
}
