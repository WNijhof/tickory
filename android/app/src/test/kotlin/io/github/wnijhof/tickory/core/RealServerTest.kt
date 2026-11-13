package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.net.HttpURLConnection
import java.net.URL
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneId
import java.util.UUID

/**
 * De app tegen een echte, draaiende server: verstaan ze elkaar? Draait alleen als het adres is opgegeven, anders
 * wordt de test overgeslagen (zo blijft `gradlew testDebugUnitTest` overal werken, ook zonder server).
 *
 *   TICKORY_TEST_SERVER=http://127.0.0.1:8795   adres van een testserver (gebruik nooit je echte gegevens)
 *   TICKORY_TEST_USER / TICKORY_TEST_PASSWORD   account op die server; standaard "test" / "test-wachtwoord-1"
 *
 * Zie android/README.md voor het starten van zo'n testserver.
 */
class RealServerTest {
    private val origin: String? = System.getenv("TICKORY_TEST_SERVER")?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }
    private val user: String = System.getenv("TICKORY_TEST_USER") ?: "test"
    private val password: String = System.getenv("TICKORY_TEST_PASSWORD") ?: "test-wachtwoord-1"
    private val zone = ZoneId.of("Europe/Amsterdam")

    private class Reply(val status: Int, val body: String)

    /** Een gewoon verzoek buiten de code van de app om, voor het klaarzetten en nakijken. */
    private fun call(method: String, path: String, body: Any?, token: String? = null): Reply {
        val connection = URL(origin + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = method
            connection.connectTimeout = 10_000
            connection.readTimeout = 20_000
            if (token != null) connection.setRequestProperty("Authorization", "Bearer $token")
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(Json.stringify(body).toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return Reply(status, stream?.use { String(it.readBytes(), Charsets.UTF_8) } ?: "")
        } finally {
            connection.disconnect()
        }
    }

    private fun sync(token: String, body: Map<String, Any?>): Map<String, Any?> {
        val reply = call("POST", "/api/v1/sync", body, token)
        assertEquals("sync gaf ${reply.status}: ${reply.body}", 200, reply.status)
        return Json.parseObject(reply.body)!!
    }

    private fun command(type: String, args: Map<String, Any?>) = mapOf("type" to type, "uuid" to "itest-" + UUID.randomUUID(), "args" to args)

    @Test
    fun `de app en de echte server verstaan elkaar`() {
        assumeTrue("zet TICKORY_TEST_SERVER om deze test te draaien", origin != null)
        val client = ApiClient(origin!!, 10_000, 20_000, "Tickory-Test/1")

        // ---------- het instelscherm: is dit een Tickory-server? ----------
        assertEquals(HealthResult.Ok, client.health())

        // ---------- inloggen (dat doet op de telefoon de web-app) ----------
        val login = call("POST", "/api/v1/auth/login", mapOf("username" to user, "password" to password, "device_name" to "Android-app (test)"))
        assertEquals("inloggen gaf ${login.status}: ${login.body}", 200, login.status)
        val token = Json.parseObject(login.body)!!.text("token")
        assertNotNull(token)
        assertTrue("het token is leeg", token!!.isNotEmpty())

        // ---------- taken en herinneringen klaarzetten ----------
        val projects = sync(token, mapOf("sync_token" to "*", "resource_types" to listOf("projects"))).list("projects")!!
        val inbox = projects.mapNotNull { Json.asObject(it)?.text("id") }.first { it.startsWith("inbox-") }

        val suffix = UUID.randomUUID().toString().substring(0, 8)
        val taskOnce = "itest-once-$suffix"
        val taskNoDue = "itest-nodue-$suffix"
        val taskDaily = "itest-daily-$suffix"
        val tomorrow = LocalDate.now(zone).plusDays(1)
        val commands = listOf(
            command("task_add", mapOf("id" to taskOnce, "project_id" to inbox, "content" to "Integratietest: eenmalig", "due" to mapOf("date" to "${tomorrow}T14:00"))),
            command("reminder_add", mapOf("id" to "itest-r1-$suffix", "task_id" to taskOnce, "type" to "relative", "minute_offset" to 30)),
            command("task_add", mapOf("id" to taskNoDue, "project_id" to inbox, "content" to "Integratietest: zonder datum")),
            command("reminder_add", mapOf("id" to "itest-r2-$suffix", "task_id" to taskNoDue, "type" to "absolute", "due" to mapOf("date" to "${tomorrow}T09:15"))),
            command(
                "task_add",
                mapOf("id" to taskDaily, "project_id" to inbox, "content" to "Integratietest: elke dag", "due" to mapOf("date" to "${tomorrow}T08:00", "recurrence" to mapOf("freq" to "daily"))),
            ),
            command("reminder_add", mapOf("id" to "itest-r3-$suffix", "task_id" to taskDaily, "type" to "relative", "minute_offset" to 0)),
        )
        val added = sync(token, mapOf("sync_token" to "*", "resource_types" to listOf("reminders"), "commands" to commands))
        for (c in commands) assertEquals("${c["type"]}: ${added.obj("sync_status")?.get(c["uuid"])}", "ok", added.obj("sync_status")?.get(c["uuid"]))

        try {
            // ---------- ophalen zoals de app dat doet, en plannen ----------
            val now = System.currentTimeMillis()
            fun plan(): Map<String, PlannedReminder> {
                val fetched = client.fetchSnapshot(token)
                assertTrue("ophalen gaf $fetched", fetched is FetchResult.Ok)
                val snapshot = (fetched as FetchResult.Ok).snapshot
                return Planner.plan(snapshot.tasks, snapshot.reminders, now, zone).associateBy { it.reminderId }
            }
            fun at(date: LocalDate, hour: Int, minute: Int) = Planner.toEpochMs(LocalDateTime.of(date.year, date.month, date.dayOfMonth, hour, minute), zone)

            val first = plan()
            assertEquals(at(tomorrow, 13, 30), first["itest-r1-$suffix"]?.triggerAtMs)
            assertEquals("Integratietest: eenmalig", first["itest-r1-$suffix"]?.title)
            assertEquals("${tomorrow}T14:00", first["itest-r1-$suffix"]?.taskDue)
            assertEquals(taskOnce, first["itest-r1-$suffix"]?.taskId)
            assertEquals(at(tomorrow, 9, 15), first["itest-r2-$suffix"]?.triggerAtMs)
            assertEquals(at(tomorrow, 8, 0), first["itest-r3-$suffix"]?.triggerAtMs)

            // ---------- "Voltooien" vanuit een melding ----------
            val onceUuid = Ids.completeUuid("itest-r1-$suffix", taskOnce, first.getValue("itest-r1-$suffix").triggerAtMs)
            assertEquals(CompleteResult.Done, client.completeTask(token, taskOnce, onceUuid))
            assertFalse("een afgevinkte taak herinnert niet meer", plan().containsKey("itest-r1-$suffix"))

            // Terugkerende taak: twee keer hetzelfde uuid (opnieuw proberen, tweede toestel) schuift maar één dag op.
            val dailyUuid = Ids.completeUuid("itest-r3-$suffix", taskDaily, first.getValue("itest-r3-$suffix").triggerAtMs)
            assertEquals(CompleteResult.Done, client.completeTask(token, taskDaily, dailyUuid))
            assertEquals(CompleteResult.Done, client.completeTask(token, taskDaily, dailyUuid))
            val afterDaily = plan()
            assertEquals("één dag opgeschoven, niet twee", at(tomorrow.plusDays(1), 8, 0), afterDaily["itest-r3-$suffix"]?.triggerAtMs)
            assertEquals("${tomorrow.plusDays(1)}T08:00", afterDaily["itest-r3-$suffix"]?.taskDue)

            // Een taak die niet bestaat: de server weigert, en dat komt als weigering terug (niet als "probeer later opnieuw").
            val missing = client.completeTask(token, "itest-bestaat-niet", Ids.completeUuid("itest-rx-$suffix", "itest-bestaat-niet", now))
            assertTrue("uitkomst: $missing", missing is CompleteResult.Rejected)

            // ---------- een sessie die niet (meer) geldig is ----------
            assertEquals(FetchResult.Unauthorized, client.fetchSnapshot("dit-is-geen-geldig-token"))
            assertEquals(CompleteResult.Unauthorized, client.completeTask("dit-is-geen-geldig-token", taskNoDue, Ids.completeUuid("itest-ry-$suffix", taskNoDue, now)))
        } finally {
            // opruimen, zodat de testserver niet volloopt als de test vaker draait
            sync(token, mapOf("sync_token" to "*", "resource_types" to listOf("reminders"), "commands" to listOf(taskOnce, taskNoDue, taskDaily).map { command("task_delete", mapOf("id" to it)) }))
        }
    }
}
