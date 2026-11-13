package io.github.wnijhof.tickory.widget

import androidx.work.ListenableWorker
import androidx.work.testing.TestWorkerBuilder
import androidx.work.workDataOf
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Request
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.syncBody
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.WidgetFixtures.taskJson
import io.github.wnijhof.tickory.core.WidgetRow
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.core.list
import io.github.wnijhof.tickory.core.obj
import io.github.wnijhof.tickory.core.text
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ReminderStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncWorker
import io.github.wnijhof.tickory.sync.WidgetSync
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executors

/** De wachtrij van afgevinkte taken naar de server, en de verversing die daarna de widgets bijwerkt. */
class WidgetSyncTest : WidgetTestBase() {
    private val anna = "user-anna-0001"
    private val bob = "user-bob-0002"

    private fun queued(task: String, ifDue: String? = null, account: String = anna, uuid: String = "tickory-w-$task-0000000000", at: Long = now) =
        QueuedComplete(task, uuid, ifDue, account, at)

    private fun commandsOf(request: Request): List<Map<String, Any?>> =
        Json.parseObject(request.body)?.list("commands")?.mapNotNull { Json.asObject(it) } ?: emptyList()

    /** Een server die alle commando's met "ok" beantwoordt (of met wat [verdict] zegt) en voor de rest [fetch] teruggeeft. */
    private fun server(fetch: () -> String = { syncBody() }, verdict: (Map<String, Any?>) -> String = { "\"ok\"" }) = FakeServer { request ->
        val commands = commandsOf(request)
        val status = commands.joinToString(",") { "\"${it.text("uuid")}\":${verdict(it)}" }
        if (commands.isNotEmpty()) Response(200, """{"sync_token":"9","sync_status":{$status},"settings":[]}""") else Response(200, fetch())
    }

    private fun worker(): SyncWorker =
        TestWorkerBuilder.from(app, SyncWorker::class.java, Executors.newSingleThreadExecutor()).setInputData(workDataOf(SyncWorker.KEY_PERIODIC to false)).build()

    private fun items(): List<String> = (WidgetModel.state(app, WidgetSource.Today) as WidgetModel.State.Ready).content.rows.filterIsInstance<WidgetRow.Item>().map { it.id }.sorted()

    private fun prepare(server: FakeServer, data: io.github.wnijhof.tickory.core.WidgetSnapshot = snapshot(listOf(task("t1", "2026-11-13"), task("t2", "2026-11-13")))) {
        signIn(server.origin, data)
    }

    // ---------- versturen ----------

    @Test
    fun `gelukt - het commando heeft de afgesproken vorm en de wachtrij is leeg`() {
        server().use { server ->
            prepare(server)
            WidgetStore.enqueue(app, queued("t1"))
            WidgetStore.enqueue(app, queued("terug", ifDue = "2026-11-13T09:00"))

            val outcome = WidgetSync.flush(app, ApiClient(server.origin), token)

            assertEquals(WidgetSync.Outcome.SENT, outcome)
            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            val request = server.requests.single()
            assertEquals("POST", request.method)
            assertEquals("/api/v1/sync", request.path)
            assertEquals("Bearer $token", request.headers["authorization"])
            val commands = commandsOf(request)
            assertEquals(
                listOf(
                    mapOf("type" to "task_complete", "uuid" to "tickory-w-t1-0000000000", "args" to mapOf("id" to "t1")),
                    mapOf("type" to "task_complete", "uuid" to "tickory-w-terug-0000000000", "args" to mapOf("id" to "terug", "if_due" to "2026-11-13T09:00")),
                ),
                commands,
            )
        }
    }

    @Test
    fun `een lege wachtrij verstuurt niets`() {
        server().use { server ->
            prepare(server)
            assertEquals(WidgetSync.Outcome.NOTHING, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertTrue(server.requests.isEmpty())
        }
    }

    @Test
    fun `geen verbinding of een serverfout - blijft staan en het uuid blijft hetzelfde bij opnieuw proberen`() {
        var failing = true
        val seen = mutableListOf<String>()
        FakeServer { request ->
            seen += commandsOf(request).map { it.text("uuid")!! }
            if (failing) Response(503, "{}") else Response(200, """{"sync_status":{"${seen.last()}":"ok"}}""")
        }.use { server ->
            prepare(server)
            WidgetStore.enqueue(app, queued("t1", uuid = "tickory-w-vast-0000000000"))

            assertEquals(WidgetSync.Outcome.OFFLINE, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertEquals(WidgetSync.Outcome.OFFLINE, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertEquals(listOf("t1"), WidgetStore.queue(app).map { it.taskId })

            failing = false
            assertEquals(WidgetSync.Outcome.SENT, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            assertEquals("elke keer hetzelfde uuid: de server voert het hooguit één keer uit", listOf("tickory-w-vast-0000000000"), seen.distinct())
            assertEquals(3, seen.size)
        }
        // ook helemaal geen server
        val dead = FakeServer.closedPortOrigin()
        Prefs(app).setServer(dead, false)
        WidgetStore.enqueue(app, queued("t2"))
        assertEquals(WidgetSync.Outcome.OFFLINE, WidgetSync.flush(app, ApiClient(dead, 500, 500), token))
        assertEquals(listOf("t2"), WidgetStore.queue(app).map { it.taskId })
    }

    @Test
    fun `de server weigert - de taak is weg of je mag er niet meer bij - blijft niet hangen`() {
        for (code in listOf("NOT_FOUND", "FORBIDDEN", "INVALID_ARG", "INTERNAL")) {
            server(verdict = { """{"error_code":"$code","error":"nee"}""" }).use { server ->
                WidgetStore.clearAll(app)
                prepare(server)
                WidgetStore.enqueue(app, queued("t1"))
                assertEquals(code, WidgetSync.Outcome.SENT, WidgetSync.flush(app, ApiClient(server.origin), token))
                assertEquals(code, emptyList<QueuedComplete>(), WidgetStore.queue(app))
            }
        }
    }

    @Test
    fun `een server die if_due nog niet kent - dezelfde actie zonder, met een nieuw uuid`() {
        val bodies = mutableListOf<List<Map<String, Any?>>>()
        server(verdict = { cmd -> if (cmd.obj("args")?.containsKey("if_due") == true) """{"error_code":"UNKNOWN_ARG","error":"onbekend argument"}""" else "\"ok\"" })
            .use { server ->
                prepare(server)
                WidgetStore.enqueue(app, queued("terug", ifDue = "2026-11-13T09:00"))
                WidgetStore.enqueue(app, queued("gewoon"))

                assertEquals(WidgetSync.Outcome.SENT, WidgetSync.flush(app, ApiClient(server.origin), token))

                server.requests.forEach { bodies += commandsOf(it) }
                assertEquals(2, bodies.size)
                assertEquals(listOf("terug", "gewoon"), bodies[0].map { it.obj("args")!!.text("id") })
                assertEquals("de tweede keer alleen de taak die het nodig had", listOf("terug"), bodies[1].map { it.obj("args")!!.text("id") })
                assertEquals(mapOf("id" to "terug"), bodies[1][0].obj("args"))
                assertNotEquals("een nieuw uuid, want de server onthoudt de weigering van het oude", bodies[0][0].text("uuid"), bodies[1][0].text("uuid"))
                assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            }
    }

    @Test
    fun `401 - de aanmelding is verlopen en de wachtrij blijft voor als je opnieuw inlogt`() {
        FakeServer { Response(401, """{"error_code":"UNAUTHORIZED","error":"x"}""") }.use { server ->
            prepare(server)
            WidgetStore.enqueue(app, queued("t1"))
            assertEquals(WidgetSync.Outcome.UNAUTHORIZED, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertTrue(Prefs(app).sessionExpired)
            assertEquals(listOf("t1"), WidgetStore.queue(app).map { it.taskId })
            assertEquals(WidgetModel.State.Expired, WidgetModel.state(app, WidgetSource.Today))
        }
    }

    @Test
    fun `de server wil het hele verzoek niet - dan niet blijven proberen`() {
        FakeServer { Response(400, """{"error_code":"INVALID_REQUEST","error":"x"}""") }.use { server ->
            prepare(server)
            WidgetStore.enqueue(app, queued("t1"))
            assertEquals(WidgetSync.Outcome.SENT, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
        }
    }

    @Test
    fun `een antwoord zonder uitkomst voor een commando - laten staan en later nog eens`() {
        FakeServer { Response(200, """{"sync_status":{}}""") }.use { server ->
            prepare(server)
            WidgetStore.enqueue(app, queued("t1"))
            assertEquals(WidgetSync.Outcome.OFFLINE, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertEquals(listOf("t1"), WidgetStore.queue(app).map { it.taskId })
        }
    }

    @Test
    fun `wat van een andere gebruiker is of ongecontroleerd, wordt nooit verstuurd`() {
        server().use { server ->
            prepare(server)
            WidgetStore.updateQueue(app) { listOf(queued("van-bob", account = bob)) }
            assertEquals("alleen wat van Anna is", WidgetSync.Outcome.NOTHING, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertTrue(server.requests.isEmpty())

            WidgetStore.enqueue(app, queued("van-anna"))
            WidgetStore.markUnverified(app)
            assertEquals("zolang niet vaststaat van wie de gegevens zijn", WidgetSync.Outcome.NOTHING, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertTrue(server.requests.isEmpty())
        }
    }

    @Test
    fun `te lang wachtende acties vervallen zonder verzoek`() {
        server().use { server ->
            prepare(server)
            WidgetStore.enqueue(app, queued("oud", at = now - 3L * 24 * 3600 * 1000 - 1))
            WidgetStore.enqueue(app, queued("nieuw", at = now - 1000))
            WidgetSync.flush(app, ApiClient(server.origin), token)
            assertEquals(listOf("nieuw"), commandsOf(server.requests.single()).map { it.obj("args")!!.text("id") })
        }
    }

    @Test
    fun `een lange wachtrij gaat in delen van vijftig`() {
        server().use { server ->
            prepare(server)
            for (i in 1..120) WidgetStore.enqueue(app, queued("t$i"))
            assertEquals(WidgetSync.Outcome.SENT, WidgetSync.flush(app, ApiClient(server.origin), token))
            assertEquals(listOf(50, 50, 20), server.requests.map { commandsOf(it).size })
            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
        }
    }

    // ---------- de hele verversing ----------

    @Test
    fun `verversing - eerst versturen, dan ophalen - de widget toont wat de server zegt`() {
        var serverTasks = "[" + listOf(taskJson("t1", "2026-11-13"), taskJson("t2", "2026-11-13")).joinToString(",") + "]"
        server(fetch = { syncBody(tasksJson = serverTasks) }).use { server ->
            prepare(server)
            // eerste verversing: de gegevens komen binnen
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertEquals(listOf("t1", "t2"), items())

            WidgetActions.complete(app, "t1")
            assertEquals("meteen weg, nog voor de server iets weet", listOf("t2"), items())
            serverTasks = "[" + taskJson("t2", "2026-11-13") + "]" // de server heeft t1 afgevinkt

            assertEquals(ListenableWorker.Result.success(), worker().doWork())

            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            assertEquals(listOf("t2"), items())
            assertEquals(listOf("t2"), WidgetStore.snapshot(app)!!.tasks.map { it.id })
            val order = server.requests.map { if (commandsOf(it).isEmpty()) "ophalen" else "versturen" }
            assertEquals(listOf("ophalen", "versturen", "ophalen"), order)
        }
    }

    @Test
    fun `verversing - zonder verbinding blijft de taak verborgen en de wachtrij staat klaar, met opnieuw proberen`() {
        val dead = FakeServer.closedPortOrigin()
        signIn(dead, snapshot(listOf(task("t1", "2026-11-13"), task("t2", "2026-11-13"))))
        WidgetActions.complete(app, "t1")

        val result = worker().doWork()

        assertEquals(ListenableWorker.Result.retry(), result)
        assertEquals(listOf("t1"), WidgetStore.queue(app).map { it.taskId })
        assertEquals(listOf("t2"), items())
    }

    @Test
    fun `verversing - een terugkerende taak komt terug met de datum van de server`() {
        var serverTasks = "[" + taskJson("terug", "2026-11-13", recurring = true) + "]"
        server(fetch = { syncBody(tasksJson = serverTasks) }).use { server ->
            prepare(server, snapshot(listOf(task("terug", "2026-11-13", recurring = true))))
            WidgetActions.complete(app, "terug")
            assertEquals(emptyList<String>(), items())
            serverTasks = "[" + taskJson("terug", "2026-11-20", recurring = true) + "]"

            worker().doWork()

            assertEquals(emptyList<String>(), items()) // volgende vrijdag, dus niet meer in Vandaag
            val upcoming = (WidgetModel.state(app, WidgetSource.Upcoming) as WidgetModel.State.Ready).content.rows.filterIsInstance<WidgetRow.Item>()
            assertEquals(listOf("terug"), upcoming.map { it.id })
            val sent = commandsOf(server.requests.first { commandsOf(it).isNotEmpty() }).single()
            assertEquals(mapOf("id" to "terug", "if_due" to "2026-11-13"), sent.obj("args"))
        }
    }

    @Test
    fun `verversing - de server weigert (taak weg, geen lid meer) en de widget blijft niet hangen`() {
        server(fetch = { syncBody(tasksJson = "[]") }, verdict = { """{"error_code":"NOT_FOUND","error":"weg"}""" }).use { server ->
            prepare(server)
            WidgetActions.complete(app, "t1")

            assertEquals(ListenableWorker.Result.success(), worker().doWork())

            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            assertEquals("zoals de server het ziet: alles weg", emptyList<String>(), items())
        }
        // en als de server de taak nog wel heeft, komt hij gewoon terug
        server(fetch = { syncBody(tasksJson = "[" + taskJson("t1", "2026-11-13") + "]") }, verdict = { """{"error_code":"FORBIDDEN","error":"nee"}""" }).use { server ->
            WidgetStore.clearAll(app)
            prepare(server)
            WidgetActions.complete(app, "t1")
            worker().doWork()
            assertEquals(listOf("t1"), items())
        }
    }

    @Test
    fun `verversing - een nieuwe aanmelding van een andere gebruiker - de oude gegevens en wachtrij zijn weg voor er iets verstuurd wordt`() {
        server(fetch = { syncBody(account = bob, tasksJson = "[" + taskJson("van-bob", "2026-11-13") + "]") }).use { server ->
            prepare(server, snapshot(listOf(task("t1", "2026-11-13")), account = anna))
            WidgetActions.complete(app, "t1")
            assertEquals(1, WidgetStore.queue(app).size)

            Session.set(app, "tky_bob-heeft-ingelogd_0123456789-ABCDEF") // andere aanmelding
            assertEquals("meteen niets van Anna te zien", WidgetModel.State.Loading, WidgetModel.state(app, WidgetSource.Today))

            worker().doWork()

            assertTrue("Annas commando is nooit onder Bobs aanmelding verstuurd", server.requests.none { commandsOf(it).isNotEmpty() })
            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            assertEquals(listOf("van-bob"), items())
            assertEquals(bob, WidgetStore.snapshot(app)!!.accountId)
        }
    }

    @Test
    fun `verversing - dezelfde gebruiker logt opnieuw in - de wachtrij gaat alsnog mee`() {
        var serverTasks = "[" + taskJson("t2", "2026-11-13") + "]"
        server(fetch = { syncBody(account = anna, tasksJson = serverTasks) }).use { server ->
            prepare(server, snapshot(listOf(task("t1", "2026-11-13"), task("t2", "2026-11-13")), account = anna))
            WidgetActions.complete(app, "t1")
            Session.set(app, "tky_anna-nieuwe-sessie_0123456789-ABCDEF")
            assertEquals(WidgetModel.State.Loading, WidgetModel.state(app, WidgetSource.Today))

            worker().doWork()

            val sent = server.requests.filter { commandsOf(it).isNotEmpty() }
            assertEquals(1, sent.size)
            assertEquals("Bearer tky_anna-nieuwe-sessie_0123456789-ABCDEF", sent.single().headers["authorization"])
            assertEquals(listOf("ophalen", "versturen", "ophalen"), server.requests.map { if (commandsOf(it).isEmpty()) "ophalen" else "versturen" })
            assertEquals(emptyList<QueuedComplete>(), WidgetStore.queue(app))
            assertEquals(listOf("t2"), items())
        }
    }

    @Test
    fun `verversing - de gegevens komen uit het antwoord van de server - alleen wat die zelf mag laten zien`() {
        // de server stuurt alleen projecten en taken waar deze gebruiker bij hoort; de app voegt daar niets aan toe
        val projects = """[{"id":"inbox-project","name":"Inbox"},{"id":"gedeeld-1","name":"Gedeeld"}]"""
        val tasks = "[" + listOf(taskJson("mijn-1", "2026-11-13"), taskJson("samen-1", "2026-11-13", project = "gedeeld-1")).joinToString(",") + "]"
        server(fetch = { syncBody(tasksJson = tasks, projectsJson = projects) }).use { server ->
            prepare(server, snapshot())
            worker().doWork()
            val shared = (WidgetModel.state(app, WidgetSource.Project("gedeeld-1")) as WidgetModel.State.Ready).content
            assertEquals(listOf("samen-1"), shared.rows.filterIsInstance<WidgetRow.Item>().map { it.id })
            // later is de gebruiker geen lid meer: de server noemt het project niet meer, en de widget toont dat het weg is
            server(fetch = { syncBody(tasksJson = "[" + taskJson("mijn-1", "2026-11-13") + "]") }).use { later ->
                Prefs(app).setServer(later.origin, false)
                worker().doWork()
                val gone = (WidgetModel.state(app, WidgetSource.Project("gedeeld-1")) as WidgetModel.State.Ready).content
                assertTrue(gone.missing)
                assertEquals(emptyList<WidgetRow>(), gone.rows)
                assertEquals(listOf("mijn-1"), items())
            }
        }
    }

    @Test
    fun `verversing - een kapot antwoord laat de widgets staan zoals ze waren`() {
        FakeServer { Response(200, "geen json") }.use { server ->
            prepare(server)
            worker().doWork()
            assertEquals(listOf("t1", "t2"), items())
        }
        FakeServer { Response(200, """{"me":{"id":"$anna"},"tasks":"nee"}""") }.use { server ->
            Prefs(app).setServer(server.origin, false)
            worker().doWork()
            assertEquals(listOf("t1", "t2"), items())
        }
    }

    @Test
    fun `verversing - de gegevens voor de herinneringen komen er ook uit`() {
        val reminders = """[{"id":"rem-00001","task_id":"t1","type":"relative","minute_offset":30,"due":null,"is_deleted":false}]"""
        server(fetch = { syncBody(tasksJson = "[" + taskJson("t1", "2026-11-13T14:00") + "]", remindersJson = reminders) }).use { server ->
            prepare(server)
            worker().doWork()
            assertEquals(listOf("t1"), ReminderStore.load(app).snapshot.tasks.map { it.id })
            assertEquals(listOf("rem-00001"), ReminderStore.load(app).snapshot.reminders.map { it.id })
        }
    }

    @Test
    fun `afmelden tijdens de verversing laat geen gegevens achter`() {
        server().use { server ->
            prepare(server)
            WidgetActions.complete(app, "t1")
            Session.signOut(app)
            assertNull(WidgetStore.snapshot(app))
            assertFalse(WidgetStore.isUnverified(app))
            assertEquals(ListenableWorker.Result.success(), worker().doWork()) // niet aangemeld: niets te doen
            assertTrue(server.requests.isEmpty())
        }
    }
}
