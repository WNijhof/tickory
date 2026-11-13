package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.FakeServer.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.net.ConnectException
import java.net.NoRouteToHostException
import java.net.SocketException
import java.net.SocketTimeoutException
import java.net.UnknownHostException
import javax.net.ssl.SSLHandshakeException

class ApiClientTest {
    private fun client(server: FakeServer, readTimeoutMs: Int = 5_000) = ApiClient(server.origin, 5_000, readTimeoutMs, "Tickory-Test/1")

    /** Een adres waar niets luistert. Ruime time-out: Windows probeert een gesloten poort een paar keer voor het opgeeft. */
    private fun nothingThere() = ApiClient(FakeServer.closedPortOrigin(), 15_000, 3_000)

    // ---------- /health ----------

    @Test
    fun `health - de server antwoordt met ok`() {
        FakeServer { Response(200, """{"ok":true}""") }.use { server ->
            assertEquals(HealthResult.Ok, client(server).health())
            val request = server.requests.single()
            assertEquals("GET", request.method)
            assertEquals("/health", request.path)
            assertNull("bij /health gaat er geen aanmelding mee", request.headers["authorization"])
            assertEquals("Tickory-Test/1", request.headers["user-agent"])
        }
    }

    @Test
    fun `health - er draait iets anders op dit adres`() {
        val others = listOf(
            Response(200, """{"ok":false}"""),
            Response(200, """{"ok":"true"}"""),
            Response(200, """{"status":"up"}"""),
            Response(200, "<html><body>Welkom bij mijn router</body></html>"),
            Response(200, ""),
            Response(200, "[true]"),
            Response(404, """{"error_code":"NOT_FOUND","error":"onbekend pad"}"""),
            Response(500, """{"ok":true}"""),
            Response(401, ""),
        )
        for (response in others) {
            FakeServer { response }.use { server ->
                assertEquals("antwoord ${response.status} '${response.body}'", HealthResult.NotTickory(response.status), client(server).health())
            }
        }
    }

    @Test
    fun `health - een doorverwijzing wordt gemeld en niet gevolgd`() {
        FakeServer { Response(301, "", mapOf("Location" to "https://taken.voorbeeld.nl/health")) }.use { server ->
            assertEquals(HealthResult.Redirect("https://taken.voorbeeld.nl/health"), client(server).health())
            assertEquals(1, server.requests.size)
        }
        FakeServer { Response(302, "") }.use { server ->
            assertEquals(HealthResult.Redirect(null), client(server).health())
        }
    }

    @Test
    fun `health - niets op dit adres`() {
        assertEquals(HealthResult.Unreachable(NetProblem.CONNECT), nothingThere().health())
    }

    @Test
    fun `health - de server reageert niet op tijd`() {
        FakeServer { Response(200, hangMs = 3_000) }.use { server ->
            assertEquals(HealthResult.Unreachable(NetProblem.TIMEOUT), client(server, readTimeoutMs = 300).health())
        }
    }

    @Test
    fun `health - een onzinnig adres geeft een uitkomst en geen fout`() {
        assertTrue(ApiClient("geen adres").health() is HealthResult.Unreachable)
        assertTrue(ApiClient("ftp://127.0.0.1").health() is HealthResult.Unreachable)
    }

    // ---------- taken en herinneringen ophalen ----------

    @Test
    fun `ophalen - het verzoek heeft de afgesproken vorm`() {
        val body = """{"sync_token":"7","tasks":[{"id":"task-0001","content":"Bellen","due":{"date":"2026-11-13T14:00"},"checked":false,"is_deleted":false}],
            "reminders":[{"id":"rem-00001","task_id":"task-0001","type":"relative","minute_offset":30,"due":null,"is_deleted":false}]}"""
        FakeServer { Response(200, body) }.use { server ->
            val result = client(server).fetchSnapshot("tky_test-token_123")
            assertTrue(result is FetchResult.Ok)
            val snapshot = (result as FetchResult.Ok).snapshot
            assertEquals(listOf("task-0001"), snapshot.tasks.map { it.id })
            assertEquals(listOf("rem-00001"), snapshot.reminders.map { it.id })

            val request = server.requests.single()
            assertEquals("POST", request.method)
            assertEquals("/api/v1/sync", request.path)
            assertEquals("Bearer tky_test-token_123", request.headers["authorization"])
            assertEquals("application/json", request.headers["content-type"])
            // behalve taken en herinneringen vraagt de app ook projecten, secties en labels, voor de widgets
            assertEquals(mapOf("sync_token" to "*", "resource_types" to listOf("tasks", "reminders", "projects", "sections", "labels")), Json.parse(request.body))
        }
    }

    @Test
    fun `ophalen - sessie verlopen`() {
        FakeServer { Response(401, """{"error_code":"UNAUTHORIZED","error":"ongeldige of ontbrekende aanmelding"}""") }.use { server ->
            assertEquals(FetchResult.Unauthorized, client(server).fetchSnapshot("tky_verlopen"))
        }
    }

    @Test
    fun `ophalen - fout van de server of een onbruikbaar antwoord is geen lege lijst`() {
        val failures = listOf(
            Response(500, """{"error_code":"INTERNAL","error":"interne fout"}"""),
            Response(502, "<html>Bad Gateway</html>"),
            Response(429, ""),
            Response(404, ""),
            Response(200, "<html>Log in op het wifi-netwerk van het hotel</html>"),
            Response(200, ""),
            Response(200, """{"tasks":[]}"""),
            Response(302, "", mapOf("Location" to "https://elders.voorbeeld.nl/api/v1/sync")),
        )
        for (response in failures) {
            FakeServer { response }.use { server ->
                val result = client(server).fetchSnapshot("tky_test")
                assertEquals("antwoord ${response.status} '${response.body}'", FetchResult.Failed(null, response.status), result)
                assertEquals("een doorverwijzing wordt niet gevolgd, zeker niet met het token", 1, server.requests.size)
            }
        }
    }

    @Test
    fun `ophalen - geen verbinding of te traag`() {
        assertEquals(FetchResult.Failed(NetProblem.CONNECT, 0), nothingThere().fetchSnapshot("tky_test"))
        FakeServer { Response(200, hangMs = 3_000) }.use { server ->
            assertEquals(FetchResult.Failed(NetProblem.TIMEOUT, 0), client(server, readTimeoutMs = 300).fetchSnapshot("tky_test"))
        }
    }

    @Test
    fun `ophalen - een groot antwoord met veel taken`() {
        val tasks = (1..5000).joinToString(",") { """{"id":"task-%05d","content":"Taak nummer %d met wat tekst erbij","due":{"date":"2026-11-13T14:00"},"checked":false,"is_deleted":false}""".format(it, it) }
        FakeServer { Response(200, """{"tasks":[$tasks],"reminders":[]}""") }.use { server ->
            val fetched = client(server).fetchSnapshot("tky_test")
            assertTrue("uitkomst: $fetched", fetched is FetchResult.Ok)
            val result = fetched as FetchResult.Ok
            assertEquals(5000, result.snapshot.tasks.size)
            assertEquals("Taak nummer 5000 met wat tekst erbij", result.snapshot.tasks.last().content)
        }
    }

    // ---------- voltooien ----------

    private val uuid = Ids.completeUuid("rem-00001", "task-0001", 1794573000000)

    @Test
    fun `voltooien - gelukt, en het verzoek heeft de afgesproken vorm`() {
        FakeServer { Response(200, """{"sync_status":{"$uuid":"ok"},"reminders":[]}""") }.use { server ->
            assertEquals(CompleteResult.Done, client(server).completeTask("tky_test-token_123", "task-0001", uuid))

            val request = server.requests.single()
            assertEquals("POST", request.method)
            assertEquals("/api/v1/sync", request.path)
            assertEquals("Bearer tky_test-token_123", request.headers["authorization"])
            assertEquals("application/json", request.headers["content-type"])
            val sent = Json.parseObject(request.body)!!
            assertEquals(listOf(mapOf("type" to "task_complete", "uuid" to uuid, "args" to mapOf("id" to "task-0001"))), sent["commands"])
        }
    }

    @Test
    fun `voltooien - geweigerd door de server`() {
        FakeServer { Response(200, """{"sync_status":{"$uuid":{"error_code":"NOT_FOUND","error":"task.id bestaat niet"}}}""") }.use { server ->
            assertEquals(CompleteResult.Rejected("NOT_FOUND", "task.id bestaat niet"), client(server).completeTask("tky_test", "task-0001", uuid))
        }
        FakeServer { Response(400, """{"error_code":"INVALID_REQUEST","error":"geen geldige JSON"}""") }.use { server ->
            assertEquals(CompleteResult.Rejected("INVALID_REQUEST", "geen geldige JSON"), client(server).completeTask("tky_test", "task-0001", uuid))
        }
        FakeServer { Response(404, "niet gevonden") }.use { server ->
            assertEquals(CompleteResult.Rejected("HTTP_404", ""), client(server).completeTask("tky_test", "task-0001", uuid))
        }
    }

    @Test
    fun `voltooien - sessie verlopen`() {
        FakeServer { Response(401, """{"error_code":"UNAUTHORIZED","error":"ongeldige of ontbrekende aanmelding"}""") }.use { server ->
            assertEquals(CompleteResult.Unauthorized, client(server).completeTask("tky_verlopen", "task-0001", uuid))
        }
    }

    @Test
    fun `voltooien - tijdelijke fouten zijn opnieuw te proberen`() {
        val temporary = listOf(
            Response(500, ""), Response(502, "<html>Bad Gateway</html>"), Response(503, ""), Response(429, ""), Response(408, ""),
            Response(200, "<html>Log in op het wifi-netwerk van het hotel</html>"),
            Response(200, """{"sync_status":{}}"""),
            Response(200, """{"sync_status":{"een-ander-uuid-1234":"ok"}}"""),
            Response(302, "", mapOf("Location" to "https://elders.voorbeeld.nl/")),
        )
        for (response in temporary) {
            FakeServer { response }.use { server ->
                val result = client(server).completeTask("tky_test", "task-0001", uuid)
                assertEquals("antwoord ${response.status} '${response.body}'", CompleteResult.Failed(null, response.status), result)
            }
        }
        assertEquals(CompleteResult.Failed(NetProblem.CONNECT, 0), nothingThere().completeTask("tky_test", "task-0001", uuid))
        FakeServer { Response(200, hangMs = 3_000) }.use { server ->
            assertEquals(CompleteResult.Failed(NetProblem.TIMEOUT, 0), client(server, readTimeoutMs = 300).completeTask("tky_test", "task-0001", uuid))
        }
    }

    // ---------- soorten netwerkfouten ----------

    @Test
    fun `netwerkfouten herkennen`() {
        assertEquals(NetProblem.UNKNOWN_HOST, ApiClient.classify(UnknownHostException("taken.voorbeeld.nl")))
        assertEquals(NetProblem.TIMEOUT, ApiClient.classify(SocketTimeoutException("timeout")))
        assertEquals(NetProblem.TLS, ApiClient.classify(SSLHandshakeException("certificaat niet vertrouwd")))
        assertEquals(NetProblem.CONNECT, ApiClient.classify(ConnectException("Connection refused")))
        assertEquals(NetProblem.CONNECT, ApiClient.classify(NoRouteToHostException("geen route")))
        assertEquals(NetProblem.CONNECT, ApiClient.classify(SocketException("Connection reset")))
        assertEquals(NetProblem.OTHER, ApiClient.classify(IOException("Cleartext HTTP traffic not permitted")))
        assertEquals(NetProblem.OTHER, ApiClient.classify(IllegalArgumentException("ongeldige header")))
    }
}
