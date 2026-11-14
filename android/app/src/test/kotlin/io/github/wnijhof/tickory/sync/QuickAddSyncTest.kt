package io.github.wnijhof.tickory.sync

import android.app.Notification
import android.app.NotificationManager
import androidx.work.ListenableWorker
import androidx.work.testing.TestWorkerBuilder
import androidx.work.workDataOf
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Request
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.QueuedQuickAdd
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.syncBody
import io.github.wnijhof.tickory.core.text
import io.github.wnijhof.tickory.quickadd.QuickAddNotifier
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.QuickAddStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.widget.WidgetTestBase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import java.io.File
import java.util.concurrent.Executors

/** De wachtrij van het kleine venster naar de server: versturen, opnieuw proberen, weigeringen als melding, en per gebruiker. */
class QuickAddSyncTest : WidgetTestBase() {
    private val anna = "user-anna-0001"
    private val bram = "user-bram-0002"
    private val notifications get() = shadowOf(app.getSystemService(NotificationManager::class.java)).allNotifications

    private fun item(n: Int = 1, text: String = "Brood halen morgen", account: String? = anna, session: String = QuickAddQueue.sessionTag(token), at: Long = now, project: String? = null, due: String? = null, priority: Int? = null) =
        QueuedQuickAdd("tickory-q-${n.toString().padStart(24, '0')}", text, project, due, priority, "2026-11-13T09:00+01:00", "Europe/Amsterdam", account, session, at)

    private fun created(id: String = "task-nieuw-00001") = Response(200, """{"quick_add":1,"dry_run":false,"repeated":false,"task":{"id":"$id"},"preview":null,"tz":"Europe/Amsterdam","typed_at":"2026-11-13T08:00:00.000Z"}""")
    private fun refused(status: Int, code: String) = Response(status, """{"quick_add":1,"error_code":"$code","error":"nee"}""")

    /** Een server die snel toevoegen beantwoordt met [answer], en de rest (de verversing) met [fetch]. */
    private fun server(fetch: () -> String = { syncBody() }, answer: (Request) -> Response = { created() }) = FakeServer { request ->
        if (request.path == ApiClient.QUICK_ADD_PATH) answer(request) else Response(200, fetch())
    }

    private fun quickRequests(server: FakeServer) = server.requests.filter { it.path == ApiClient.QUICK_ADD_PATH }

    private fun worker(): SyncWorker =
        TestWorkerBuilder.from(app, SyncWorker::class.java, Executors.newSingleThreadExecutor()).setInputData(workDataOf(SyncWorker.KEY_PERIODIC to false)).build()

    private fun prepare(server: FakeServer) = signIn(server.origin, snapshot())

    private fun title(n: Notification) = n.extras.getCharSequence(Notification.EXTRA_TITLE).toString()
    private fun body(n: Notification) = n.extras.getCharSequence(Notification.EXTRA_TEXT).toString()

    @Test
    fun `gelukt - het verzoek heeft de afgesproken vorm, de wachtrij is leeg en daarna wordt er ververst`() {
        server().use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item(project = "project-werk-001", due = "tomorrow", priority = 2))
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            val sent = quickRequests(server).single()
            assertEquals("POST", sent.method)
            assertEquals("Bearer $token", sent.headers["authorization"])
            val body = Json.parseObject(sent.body)!!
            assertEquals("Brood halen morgen", body.text("text"))
            assertEquals("tickory-q-000000000000000000000001", body.text("uuid"))
            assertEquals("project-werk-001", body.text("project_id"))
            assertEquals("2026-11-13T09:00+01:00", body.text("typed_at"))
            assertEquals("Europe/Amsterdam", body.text("tz"))
            assertEquals("tomorrow", body.text("due"))
            assertEquals(2L, body["priority"])
            assertTrue(QuickAddStore.queue(app).isEmpty())
            assertTrue("na het versturen opnieuw ophalen", server.requests.last().path == ApiClient.SYNC_PATH)
            assertTrue(notifications.isEmpty())
        }
    }

    @Test
    fun `geen verbinding - blijft staan, ook na een herstart, en gaat later met hetzelfde uuid`() {
        signIn(FakeServer.closedPortOrigin(), snapshot())
        QuickAddStore.enqueue(app, item())
        assertEquals(ListenableWorker.Result.retry(), worker().doWork())
        // "herstart": de wachtrij staat in een bestand, niet in het geheugen
        val file = File(app.filesDir, "quickadd/queue.json")
        assertTrue(file.isFile)
        assertEquals(listOf("tickory-q-000000000000000000000001"), QuickAddQueue.decode(file.readText()).map { it.uuid })
        server().use { server ->
            Prefs(app).setServer(server.origin, false)
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertEquals("tickory-q-000000000000000000000001", Json.parseObject(quickRequests(server).single().body)!!.text("uuid"))
            assertTrue(QuickAddStore.queue(app).isEmpty())
        }
    }

    @Test
    fun `een tijdelijke fout (500, 503, 429, 408) - blijft staan`() {
        for (status in listOf(500, 503, 429, 408)) {
            server(answer = { Response(status, """{"quick_add":1,"error_code":"BUSY","error":"druk"}""") }).use { server ->
                prepare(server)
                QuickAddStore.enqueue(app, item())
                assertEquals("$status", ListenableWorker.Result.retry(), worker().doWork())
                assertEquals("$status", 1, QuickAddStore.queue(app).size)
                assertTrue(notifications.isEmpty())
                QuickAddStore.clearAll(app)
            }
        }
    }

    @Test
    fun `de server weigert - weg uit de wachtrij, en een melding met de tekst en waarom`() {
        val cases = listOf(
            refused(403, "FORBIDDEN") to "Je kunt dit project alleen lezen.",
            refused(404, "NOT_FOUND") to "Het project bestaat niet meer, of je bent er geen lid meer van.",
            refused(409, "LIMIT_REACHED") to "Er is een grens bereikt (bijvoorbeeld het aantal taken of labels).",
            refused(400, "INVALID_ARG") to "Van deze tekst kon geen taak worden gemaakt (bijvoorbeeld alleen een datum of label).",
            refused(400, "IETS_NIEUWS") to "De server weigerde de taak (IETS_NIEUWS).",
        )
        for ((n, case) in cases.withIndex()) {
            val (answer, why) = case
            server(answer = { answer }).use { server ->
                prepare(server)
                QuickAddStore.enqueue(app, item(n = n, text = "Taak nummer $n", project = "project-werk-001", due = "tomorrow", priority = 2))
                assertEquals(ListenableWorker.Result.success(), worker().doWork())
                assertTrue(QuickAddStore.queue(app).isEmpty())
                val note = notifications.single { title(it) == "Niet toegevoegd: Taak nummer $n" }
                assertEquals(why, body(note))
                assertEquals(QuickAddNotifier.CHANNEL_ID, note.channelId)
                // een tik opent de app met de tekst (met de prioriteit erbij), het project en de dag van "Morgen"
                val open = shadowOf(note.contentIntent).savedIntent
                assertEquals(MainActivity::class.java.name, open.component!!.className)
                assertEquals("Taak nummer $n p2", open.getStringExtra(DeepLink.EXTRA_DRAFT_TEXT))
                assertEquals("project-werk-001", open.getStringExtra(DeepLink.EXTRA_DRAFT_PROJECT))
                assertEquals("2026-11-14", open.getStringExtra(DeepLink.EXTRA_DRAFT_DUE))
                assertTrue(shadowOf(note.contentIntent).isActivityIntent)
            }
        }
        assertEquals(cases.size, notifications.size)
    }

    @Test
    fun `een oudere server zonder snel toevoegen (404 zonder quick_add) - een melding dat de server moet worden bijgewerkt`() {
        server(answer = { Response(404, """{"error_code":"NOT_FOUND","error":"onbekend pad"}""") }).use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item())
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertTrue(QuickAddStore.queue(app).isEmpty())
            assertTrue(body(notifications.single()).startsWith("Je server kent het snelle toevoegen nog niet."))
        }
    }

    @Test
    fun `401 - de aanmelding is verlopen en de taak blijft voor als je opnieuw inlogt`() {
        server(answer = { Response(401, """{"error_code":"UNAUTHORIZED","error":"x"}""") }).use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item())
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertTrue(Prefs(app).sessionExpired)
            assertEquals(1, QuickAddStore.queue(app).size)
            assertTrue(notifications.isEmpty())
        }
    }

    @Test
    fun `van een ander account - nooit versturen, wel een melding, van hetzelfde account na opnieuw inloggen - gewoon versturen`() {
        server(fetch = { syncBody(account = anna) }).use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item(n = 1, text = "Van Bram", account = bram))
            QuickAddStore.enqueue(app, item(n = 2, text = "Van Anna", account = anna))
            QuickAddStore.enqueue(app, item(n = 3, text = "Zonder account, deze aanmelding", account = null))
            QuickAddStore.enqueue(app, item(n = 4, text = "Zonder account, vorige aanmelding", account = null, session = QuickAddQueue.sessionTag("tky_oud-token-00000000000")))
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertEquals(listOf("Van Anna", "Zonder account, deze aanmelding"), quickRequests(server).map { Json.parseObject(it.body)!!.text("text") })
            assertTrue(QuickAddStore.queue(app).isEmpty())
            assertEquals(setOf("Niet toegevoegd: Van Bram", "Niet toegevoegd: Zonder account, vorige aanmelding"), notifications.map { title(it) }.toSet())
            assertTrue(notifications.all { body(it) == "Er is intussen met een ander account ingelogd." })
        }
        // Anna logt opnieuw in (een ander token): wat van Anna was gaat mee, ook al verandert de vingerafdruk
        server(fetch = { syncBody(account = anna) }).use { server ->
            QuickAddStore.enqueue(app, item(n = 5, text = "Later van Anna", account = anna))
            Prefs(app).setServer(server.origin, false)
            Session.set(app, "tky_nieuw-token_0123456789-ABCDEFG")
            assertTrue(WidgetStore.isUnverified(app))
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertEquals(listOf("Later van Anna"), quickRequests(server).map { Json.parseObject(it.body)!!.text("text") })
        }
    }

    @Test
    fun `een nieuwe aanmelding van een andere gebruiker - eerst vaststellen van wie de gegevens zijn, dan pas iets beslissen`() {
        server(fetch = { syncBody(account = bram) }).use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item(text = "Van Anna", account = anna))
            Session.set(app, "tky_bram-token_0123456789-ABCDEFGH")
            assertTrue(WidgetStore.isUnverified(app))
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertTrue("niets van Anna onder Bram verstuurd", quickRequests(server).isEmpty())
            assertEquals(bram, WidgetStore.snapshot(app)!!.accountId)
            assertEquals("Niet toegevoegd: Van Anna", title(notifications.single()))
            assertTrue(QuickAddStore.queue(app).isEmpty())
        }
    }

    @Test
    fun `zolang niet vaststaat van wie de gegevens zijn - niets versturen`() {
        server().use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item())
            WidgetStore.markUnverified(app)
            val client = ApiClient(server.origin)
            assertEquals(QuickAddSync.Outcome.NOTHING, QuickAddSync.flush(app, client, token))
            assertTrue(quickRequests(server).isEmpty())
            assertEquals(1, QuickAddStore.queue(app).size)
        }
    }

    @Test
    fun `wat twee weken wacht vervalt, met een melding en zonder verzoek`() {
        server().use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item(at = now - QuickAddQueue.RETENTION_MS - 1, text = "Heel oud"))
            assertEquals(QuickAddSync.Outcome.SENT, QuickAddSync.flush(app, ApiClient(server.origin), token))
            assertTrue(quickRequests(server).isEmpty())
            assertTrue(QuickAddStore.queue(app).isEmpty())
            assertEquals("Er was twee weken geen verbinding met de server.", body(notifications.single()))
        }
    }

    @Test
    fun `een lange wachtrij gaat in delen, de rest blijft voor de volgende keer`() {
        server().use { server ->
            prepare(server)
            for (n in 1..QuickAddQueue.PER_RUN + 3) QuickAddStore.enqueue(app, item(n = n))
            assertEquals(QuickAddSync.Outcome.SENT, QuickAddSync.flush(app, ApiClient(server.origin), token))
            assertEquals(QuickAddQueue.PER_RUN, quickRequests(server).size)
            assertEquals(3, QuickAddStore.queue(app).size)
        }
    }

    @Test
    fun `afmelden - de wachtrij is weg, met een melding per taak die niet verstuurd was`() {
        server().use { server ->
            prepare(server)
            QuickAddStore.enqueue(app, item(n = 1, text = "Een"))
            QuickAddStore.enqueue(app, item(n = 2, text = "Twee"))
            QuickAddStore.saveDraft(app, anna, "Concept")
            QuickAddStore.setLastProject(app, anna, "project-werk-001")
            Session.signOut(app)
            assertTrue(QuickAddStore.queue(app).isEmpty())
            assertEquals(null, QuickAddStore.draft(app, anna))
            assertEquals(null, QuickAddStore.lastProject(app, anna))
            assertEquals(setOf("Niet toegevoegd: Een", "Niet toegevoegd: Twee"), notifications.map { title(it) }.toSet())
            assertTrue(notifications.all { body(it) == "Je bent afgemeld voordat de taak verstuurd was." })
        }
    }

    @Test
    fun `een kapot bestand - een lege wachtrij, geen fout, en het bestand wordt in zijn geheel vervangen`() {
        val dir = File(app.filesDir, "quickadd").also { it.mkdirs() }
        File(dir, "queue.json").writeText("{kapot")
        assertTrue(QuickAddStore.queue(app).isEmpty())
        assertTrue(QuickAddStore.enqueue(app, item()))
        assertEquals(1, QuickAddStore.queue(app).size)
        assertFalse("geen tijdelijk bestand achtergebleven", File(dir, "queue.json.tmp").exists())
        assertFalse("hetzelfde uuid niet twee keer", QuickAddStore.enqueue(app, item()))
    }

    @Test
    fun `zonder toestemming voor meldingen - de tekst komt terug in het venster, met de reden, na afmelden of bij een ander account niet`() {
        shadowOf(app).denyPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        QuickAddNotifier.notDelivered(app, item(n = 1, text = "Geweigerd", project = "project-werk-001"), QuickAddNotifier.Reason.FORBIDDEN)
        QuickAddNotifier.notDelivered(app, item(n = 2, text = "Afgemeld"), QuickAddNotifier.Reason.SIGNED_OUT)
        QuickAddNotifier.notDelivered(app, item(n = 3, text = "Ander account"), QuickAddNotifier.Reason.OTHER_ACCOUNT)
        QuickAddNotifier.notDelivered(app, item(n = 4, text = "Van Bram", account = bram), QuickAddNotifier.Reason.EXPIRED)
        assertTrue(notifications.isEmpty())
        assertEquals("niet voor een ander account", null, QuickAddStore.takeReturned(app, "user-carol-003"))
        val first = QuickAddStore.takeReturned(app, anna)!!
        assertEquals("Geweigerd", first.text)
        assertEquals("project-werk-001", first.projectId)
        assertEquals("Je kunt dit project alleen lezen.", first.why)
        assertEquals("de taak van Bram krijgt Anna niet te zien", null, QuickAddStore.takeReturned(app, anna))
        assertEquals("Van Bram", QuickAddStore.takeReturned(app, bram)!!.text)
        // ook als meldingen voor de app uit staan (Android 12 en ouder: geen toestemming, wel een schakelaar)
        shadowOf(app).grantPermissions(android.Manifest.permission.POST_NOTIFICATIONS)
        shadowOf(app.getSystemService(NotificationManager::class.java)).setNotificationsEnabled(false)
        assertFalse(QuickAddNotifier.canNotify(app))
        QuickAddNotifier.notDelivered(app, item(n = 5, text = "Meldingen uit"), QuickAddNotifier.Reason.LIMIT)
        assertEquals("Meldingen uit", QuickAddStore.takeReturned(app, anna)!!.text)
        assertNotNull(notifications)
    }

    @Test
    fun `de dag bij een melding - Vandaag en Morgen zoals ze bij het intypen bedoeld waren`() {
        assertEquals("2026-11-13", QuickAddNotifier.dayOf(item(due = "today")))
        assertEquals("2026-11-14", QuickAddNotifier.dayOf(item(due = "tomorrow")))
        assertEquals(null, QuickAddNotifier.dayOf(item(due = null)))
        // laat op de avond in Amsterdam is het in Tokio al de volgende dag
        val late = item(due = "today").copy(typedAt = "2026-11-13T23:30+01:00", tz = "Asia/Tokyo")
        assertEquals("2026-11-14", QuickAddNotifier.dayOf(late))
        assertEquals(null, QuickAddNotifier.dayOf(late.copy(tz = "Mars/Olympus")))
    }
}
