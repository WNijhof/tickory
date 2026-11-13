package io.github.wnijhof.tickory.core

import java.net.InetAddress

/**
 * Ligt een adres op het eigen (thuis)netwerk? Vanaf Android 17 mag een app zulke adressen pas bereiken nadat de
 * gebruiker de toestemming "Apparaten in de buurt" (ACCESS_LOCAL_NETWORK) heeft gegeven. Zonder Android-klassen.
 */
object LocalNetwork {
    private val IPV4 = Regex("^(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})\\.(\\d{1,3})$")
    private val LOCAL_SUFFIXES = listOf(".local", ".lan", ".home", ".internal", ".home.arpa", ".localdomain", ".fritz.box")

    /**
     * Is [host] (zoals in het serveradres: naam, IPv4-adres of IPv6-adres tussen blokhaken) vrijwel zeker lokaal?
     * Kijkt alleen naar de tekst en zoekt niets op. Een gewone domeinnaam geeft false, ook als die thuis naar een
     * lokaal adres wijst; gebruik daarvoor [resolvesToLocal].
     */
    fun hostLooksLocal(host: String): Boolean {
        val h = host.lowercase().removeSuffix(".")
        if (h.startsWith("[")) {
            val bytes = try {
                InetAddress.getByName(h).address // een letterlijk adres: er wordt niets opgezocht
            } catch (_: Exception) {
                return false
            }
            return isLocalAddress(bytes)
        }
        val v4 = IPV4.matchEntire(h)
        if (v4 != null) {
            val parts = v4.groupValues.drop(1).map { it.toInt() }
            if (parts.any { it > 255 }) return false
            return isLocalAddress(ByteArray(4) { parts[it].toByte() })
        }
        if (!h.contains('.')) return h != "localhost" // één woord, zoals "nas" of "raspberrypi"
        return LOCAL_SUFFIXES.any { h.endsWith(it) }
    }

    /** Is [host] het toestel zelf (localhost, 127.x.x.x, ::1)? Verkeer daarheen verlaat het toestel niet. Alleen de tekst, geen opzoeking. */
    fun isLoopbackHost(host: String): Boolean {
        val h = host.lowercase().removeSuffix(".")
        return h == "localhost" || h == "[::1]" || IPV4.matchEntire(h)?.groupValues?.get(1) == "127"
    }

    /** Zoekt [host] op en kijkt of een van de adressen lokaal is. Doet netwerkverkeer (DNS): niet op de hoofddraad aanroepen. */
    fun resolvesToLocal(host: String): Boolean = try {
        InetAddress.getAllByName(host.removePrefix("[").removeSuffix("]")).any { isLocalAddress(it.address) }
    } catch (_: Exception) {
        false
    }

    /**
     * Privé-adressen (10/8, 172.16/12, 192.168/16), link-local (169.254/16, fe80::/10), gedeelde adresruimte van
     * providers en VPN's (100.64/10) en unieke lokale IPv6-adressen (fc00::/7). Het eigen toestel (127.0.0.1, ::1) telt niet mee.
     */
    fun isLocalAddress(address: ByteArray): Boolean {
        fun b(i: Int) = address[i].toInt() and 0xff
        return when (address.size) {
            4 -> isLocalV4(b(0), b(1))
            16 -> {
                val mapped = (0..9).all { b(it) == 0 } && b(10) == 0xff && b(11) == 0xff
                when {
                    mapped -> isLocalV4(b(12), b(13))
                    b(0) == 0xfe && (b(1) and 0xc0) == 0x80 -> true // fe80::/10
                    (b(0) and 0xfe) == 0xfc -> true // fc00::/7
                    else -> false
                }
            }
            else -> false
        }
    }

    private fun isLocalV4(a: Int, b: Int): Boolean = when {
        a == 10 -> true
        a == 172 && b in 16..31 -> true
        a == 192 && b == 168 -> true
        a == 169 && b == 254 -> true
        a == 100 && b in 64..127 -> true
        else -> false
    }
}
