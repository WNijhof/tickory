package io.github.wnijhof.tickory.core

import java.io.BufferedInputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.concurrent.thread

/**
 * Een piepkleine HTTP-server voor de tests, alleen op dit toestel (127.0.0.1) en op een vrije poort.
 * Onthoudt elk verzoek, zodat een test kan nakijken wat de app precies verstuurde.
 */
class FakeServer(private val handler: (Request) -> Response) : AutoCloseable {
    data class Request(val method: String, val path: String, val headers: Map<String, String>, val body: String)

    /** @property hangMs als dit groter is dan 0: zo lang wachten en dan de verbinding sluiten zonder antwoord */
    data class Response(val status: Int, val body: String = "", val headers: Map<String, String> = emptyMap(), val hangMs: Long = 0)

    private val socket = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))
    val requests = CopyOnWriteArrayList<Request>()
    val origin: String get() = "http://127.0.0.1:${socket.localPort}"

    init {
        thread(isDaemon = true, name = "fake-server") {
            while (!socket.isClosed) {
                val client = try {
                    socket.accept()
                } catch (_: IOException) {
                    break
                }
                thread(isDaemon = true) {
                    try {
                        client.use { serve(it) }
                    } catch (_: Exception) {
                        // de test is al klaar of de afzender heeft opgehangen
                    }
                }
            }
        }
    }

    /**
     * Beantwoordt verzoeken op één verbinding tot de afzender die sluit, zoals een echte server met keep-alive.
     * Bewust niet "antwoorden en meteen ophangen": een netwerkfilter op de pc (AdGuard en dergelijke kijkt ook naar
     * verkeer op 127.0.0.1) raakt dan bij antwoorden boven 64 kB het staartje kwijt, en de test wacht tot de time-out.
     */
    private fun serve(client: Socket) {
        client.soTimeout = 15_000
        val input = BufferedInputStream(client.getInputStream())
        while (serveOne(client, input)) {
            // volgende verzoek op dezelfde verbinding
        }
    }

    /** @return false als de verbinding klaar is (afzender sloot, of het antwoord was "hangen") */
    private fun serveOne(client: Socket, input: BufferedInputStream): Boolean {
        val head = ByteArrayOutputStream()
        var matched = 0 // hoeveel tekens van "\r\n\r\n" al gezien zijn
        while (matched < 4) {
            val b = input.read()
            if (b < 0) return false
            if (head.size() == 0 && b == 0x16) {
                // Iemand probeert https (een TLS-begroeting) op deze http-server: meteen in gewone tekst antwoorden en ophangen,
                // zoals een echte http-server doet. De afzender merkt dan direct dat hier geen https draait.
                client.getOutputStream().write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n".toByteArray(Charsets.ISO_8859_1))
                client.getOutputStream().flush()
                return false
            }
            head.write(b)
            val expected = if (matched % 2 == 0) '\r'.code else '\n'.code
            matched = if (b == expected) matched + 1 else if (b == '\r'.code) 1 else 0
        }
        val lines = head.toString("ISO-8859-1").trim().split("\r\n")
        val requestLine = lines[0].split(" ")
        val headers = lines.drop(1).associate { line ->
            val colon = line.indexOf(':')
            line.substring(0, colon).trim().lowercase() to line.substring(colon + 1).trim()
        }
        val length = headers["content-length"]?.toInt() ?: 0
        val bodyBytes = ByteArray(length)
        var read = 0
        while (read < length) {
            val n = input.read(bodyBytes, read, length - read)
            if (n < 0) break
            read += n
        }
        val request = Request(requestLine[0], requestLine[1], headers, String(bodyBytes, Charsets.UTF_8))
        requests.add(request)

        val response = handler(request)
        if (response.hangMs > 0) {
            Thread.sleep(response.hangMs)
            return false
        }
        val bytes = response.body.toByteArray(Charsets.UTF_8)
        val headerText = StringBuilder("HTTP/1.1 ${response.status} Test\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${bytes.size}\r\n")
        for ((name, value) in response.headers) headerText.append(name).append(": ").append(value).append("\r\n")
        headerText.append("\r\n")
        val out = client.getOutputStream()
        out.write(headerText.toString().toByteArray(Charsets.ISO_8859_1))
        out.write(bytes)
        out.flush()
        return true
    }

    override fun close() {
        socket.close()
    }

    companion object {
        /** Een poort waarop niets luistert: openen en meteen weer sluiten. */
        fun closedPortOrigin(): String {
            val port = ServerSocket(0, 1, InetAddress.getByName("127.0.0.1")).use { it.localPort }
            return "http://127.0.0.1:$port"
        }
    }
}
