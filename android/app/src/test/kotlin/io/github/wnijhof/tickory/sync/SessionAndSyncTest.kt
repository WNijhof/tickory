package io.github.wnijhof.tickory.sync

import android.Manifest
import android.app.AlarmManager
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.NetworkType
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.PlannedReminder
import io.github.wnijhof.tickory.core.ReminderInfo
import io.github.wnijhof.tickory.core.SyncSnapshot
import io.github.wnijhof.tickory.core.TaskInfo
import io.github.wnijhof.tickory.core.list
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ReminderStore
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.reminders.ActionReceiver
import io.github.wnijhof.tickory.reminders.AlarmReceiver
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.reminders.ReminderEngine
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager
import java.time.Instant
import java.util.TimeZone
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import javax.crypto.KeyGenerator

/**
 * Aanmelden, verversen en "Voltooien" op een nagebootst Android (Robolectric), tegen een testserver op deze pc.
 * De sleutel komt hier uit de test in plaats van uit de Android Keystore, want die bestaat alleen op een toestel.
 */
@Suppress("DEPRECATION") // Robolectric biedt de velden van een gepland alarm nog alleen op deze manier aan
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class SessionAndSyncTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val alarms get() = shadowOf(app.getSystemService(AlarmManager::class.java))
    private val notifications get() = shadowOf(app.getSystemService(NotificationManager::class.java))
    private val originalZone: TimeZone = TimeZone.getDefault()
    private val originalExecutor: Executor = Background.executor
    private val token = "tky_test-token_0123456789-ABCDEFGHIJ"
    private val minute = 60_000L

    private fun utc(iso: String): Long = Instant.parse(iso).toEpochMilli()

    /** 10:00 in Amsterdam; de taak staat om 14:00 met een herinnering een half uur ervoor (11:30 UTC). */
    private val now = utc("2030-06-14T08:00:00Z")
    private val trigger = utc("2030-06-14T11:30:00Z")

    private val syncBody = """{"sync_token":"9","sync_status":{},
        "tasks":[{"id":"task-0001","content":"Tandarts bellen","due":{"date":"2030-06-14T14:00"},"checked":false,"is_deleted":false}],
        "reminders":[{"id":"rem-00001","task_id":"task-0001","type":"relative","minute_offset":30,"due":null,"is_deleted":false}]}"""

    private val reminder = PlannedReminder("rem-00001", "task-0001", "Tandarts bellen", trigger, "2030-06-14T14:00")
    private val uuid = Ids.completeUuid("rem-00001", "task-0001", trigger)

    @Before
    fun setUp() {
        TimeZone.setDefault(TimeZone.getTimeZone("Europe/Amsterdam"))
        AppClock.now = { now }
        Background.executor = Executor { it.run() } // meteen uitvoeren: zo is de volgorde in de test vast
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
    }

    @After
    fun tearDown() {
        AppClock.now = { System.currentTimeMillis() }
        Background.executor = originalExecutor
        TimeZone.setDefault(originalZone)
    }

    private fun worker(periodic: Boolean = false, attempt: Int = 0): SyncWorker =
        TestWorkerBuilder.from(app, SyncWorker::class.java, Executors.newSingleThreadExecutor())
            .setInputData(workDataOf(SyncWorker.KEY_PERIODIC to periodic))
            .setRunAttemptCount(attempt)
            .build()

    private fun work(name: String): List<WorkInfo> = WorkManager.getInstance(app).getWorkInfosForUniqueWork(name).get()

    private fun signIn(server: FakeServer) {
        Prefs(app).setServer(server.origin, false)
        Session.set(app, token)
    }

    // ---------- aanmelden en afmelden ----------

    @Test
    fun `het token wordt versleuteld bewaard en het verversen per kwartier start`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            signIn(server)

            val stored = Prefs(app).encryptedToken
            assertNotNull(stored)
            assertFalse("het token mag niet leesbaar in de opslag staan", stored!!.contains("test-token"))
            assertEquals(token, TokenVault.load(app))
            assertTrue(Session.isActive(app))

            val periodic = work("tickory-sync-periodic").single()
            assertEquals(WorkInfo.State.ENQUEUED, periodic.state)
            assertEquals(NetworkType.CONNECTED, periodic.constraints.requiredNetworkType)
            assertEquals("elk kwartier", 15 * minute, periodic.periodicityInfo?.repeatIntervalMillis)
            assertEquals(1, work("tickory-sync-now").size)
        }
    }

    @Test
    fun `afmelden wist het token, stopt het verversen en haalt alarmen en meldingen weg`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            signIn(server)
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertEquals(1, alarms.scheduledAlarms.size)

            Session.set(app, "")

            assertNull(Prefs(app).encryptedToken)
            assertNull(TokenVault.load(app))
            assertFalse(Session.isActive(app))
            assertTrue(alarms.scheduledAlarms.isEmpty())
            assertTrue(ReminderStore.load(app).snapshot.tasks.isEmpty())
            assertTrue(work("tickory-sync-periodic").all { it.state == WorkInfo.State.CANCELLED })
            assertTrue(work("tickory-sync-now").all { it.state.isFinished })

            // zonder sessie doet een verversing niets meer, ook niet richting de server
            val before = server.requests.size
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertEquals(before, server.requests.size)
        }
    }

    @Test
    fun `een ander token wist eerst de alarmen van de vorige gebruiker`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            signIn(server)
            worker().doWork()
            assertEquals(1, alarms.scheduledAlarms.size)

            Session.set(app, "tky_een-andere-gebruiker_9876543210")
            assertTrue("de alarmen van de vorige gebruiker zijn weg", alarms.scheduledAlarms.isEmpty())
            assertEquals("tky_een-andere-gebruiker_9876543210", TokenVault.load(app))

            // hetzelfde token nog eens doorgeven (dat doet de web-app bij elke start) verandert niets
            worker().doWork()
            assertEquals(1, alarms.scheduledAlarms.size)
            Session.set(app, "tky_een-andere-gebruiker_9876543210")
            assertEquals(1, alarms.scheduledAlarms.size)
        }
    }

    @Test
    fun `onbruikbare tokens worden genegeerd`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            Prefs(app).setServer(server.origin, false)
            for (bad in listOf("met spatie", "regel\neinde", "tab\t", "niet-ascii-é", "x".repeat(5000))) {
                Session.set(app, bad)
                assertNull("'${bad.take(20)}'", Prefs(app).encryptedToken)
            }
        }
    }

    // ---------- verversen ----------

    @Test
    fun `verversen haalt de taken op met het token en zet het alarm`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            signIn(server)
            assertEquals(ListenableWorker.Result.success(), worker().doWork())

            val request = server.requests.single()
            assertEquals("/api/v1/sync", request.path)
            assertEquals("Bearer $token", request.headers["authorization"])
            assertTrue(request.headers["user-agent"]!!.startsWith("Tickory-Android/"))
            assertEquals(listOf("tasks", "reminders", "projects", "sections", "labels", "places"), Json.parseObject(request.body)!!.list("resource_types"))

            assertEquals(trigger, alarms.scheduledAlarms.single().triggerAtMs)
        }
    }

    @Test
    fun `sessie verlopen - verversen stopt, de alarmen blijven staan`() {
        var status = 200
        FakeServer { if (status == 200) Response(200, syncBody) else Response(401, """{"error_code":"UNAUTHORIZED","error":"ongeldige of ontbrekende aanmelding"}""") }.use { server ->
            signIn(server)
            worker().doWork()
            assertEquals(1, alarms.scheduledAlarms.size)

            status = 401
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            assertTrue(Prefs(app).sessionExpired)
            assertFalse(Session.isActive(app))
            assertEquals("bestaande alarmen blijven staan", trigger, alarms.scheduledAlarms.single().triggerAtMs)
            assertTrue(work("tickory-sync-periodic").all { it.state == WorkInfo.State.CANCELLED })

            // tot de web-app opnieuw een sessie doorgeeft, gaat er niets meer naar de server
            val before = server.requests.size
            worker().doWork()
            assertEquals(before, server.requests.size)

            // en het alarm gaat gewoon af
            AppClock.now = { trigger }
            AlarmReceiver().onReceive(app, shadowOf(alarms.scheduledAlarms.single().operation).savedIntent)
            assertNotNull(notifications.getNotification("rem-00001", 1))

            // opnieuw aangemeld met een nieuw token: het verversen loopt weer
            status = 200
            Session.set(app, "tky_nieuwe-sessie_1234567890")
            assertTrue(Session.isActive(app))
            assertTrue(work("tickory-sync-periodic").any { it.state == WorkInfo.State.ENQUEUED })
        }
    }

    @Test
    fun `server onbereikbaar of onzin terug - het plan blijft staan en we proberen het later opnieuw`() {
        var mode = "ok"
        FakeServer {
            when (mode) {
                "ok" -> Response(200, syncBody)
                "kapot" -> Response(500, "")
                "leeg" -> Response(200, """{"tasks":[]}""") // herinneringen ontbreken: geen geldig antwoord
                else -> Response(200, "<html>Log in op het wifi-netwerk</html>")
            }
        }.use { server ->
            signIn(server)
            worker().doWork()
            assertEquals(1, alarms.scheduledAlarms.size)

            for (broken in listOf("kapot", "leeg", "html")) {
                mode = broken
                assertEquals("eenmalig: opnieuw proberen ($broken)", ListenableWorker.Result.retry(), worker(attempt = 0).doWork())
                assertEquals("na vier pogingen ophouden ($broken)", ListenableWorker.Result.success(), worker(attempt = 4).doWork())
                assertEquals("het kwartierwerk komt vanzelf terug ($broken)", ListenableWorker.Result.success(), worker(periodic = true).doWork())
                assertEquals("het alarm blijft staan ($broken)", trigger, alarms.scheduledAlarms.single().triggerAtMs)
                assertFalse(Prefs(app).sessionExpired)
            }
        }
    }

    // ---------- "Voltooien" vanuit de melding ----------

    private fun showNotification() {
        ReminderEngine.onSynced(
            app,
            SyncSnapshot(listOf(TaskInfo("task-0001", "Tandarts bellen", "2030-06-14T14:00")), listOf(ReminderInfo("rem-00001", "task-0001", "relative", 30, null))),
        )
        AppClock.now = { trigger }
        AlarmReceiver().onReceive(app, shadowOf(alarms.scheduledAlarms.single().operation).savedIntent)
        assertNotNull(notifications.getNotification("rem-00001", 1))
    }

    private fun tapComplete() {
        val action = notifications.getNotification("rem-00001", 1).actions.first { it.title.toString() == "Voltooien" }
        ActionReceiver().onReceive(app, shadowOf(action.actionIntent).savedIntent)
    }

    private fun text(notification: Notification): String = notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString()

    @Test
    fun `voltooien - de taak wordt bij de server afgevinkt en de melding verdwijnt`() {
        FakeServer { request ->
            if (request.body.contains("task_complete")) Response(200, """{"sync_status":{"$uuid":"ok"},"reminders":[]}""") else Response(200, syncBody)
        }.use { server ->
            signIn(server)
            showNotification()
            tapComplete()

            val sent = server.requests.first { it.body.contains("task_complete") }
            assertEquals("Bearer $token", sent.headers["authorization"])
            assertEquals(
                listOf(mapOf("type" to "task_complete", "uuid" to uuid, "args" to mapOf("id" to "task-0001"))),
                Json.parseObject(sent.body)!!["commands"],
            )
            assertNull("de melding is weg", notifications.getNotification("rem-00001", 1))
            assertTrue(ReminderStore.load(app).pendingCompletes.isEmpty())
        }
    }

    @Test
    fun `voltooien zonder verbinding - de melding legt het uit en de volgende verversing maakt het af met hetzelfde uuid`() {
        var online = false
        FakeServer { request ->
            when {
                !online -> Response(503, "")
                request.body.contains("task_complete") -> Response(200, """{"sync_status":{"$uuid":"ok"},"reminders":[]}""")
                else -> Response(200, """{"tasks":[{"id":"task-0001","content":"Tandarts bellen","due":{"date":"2030-06-14T14:00"},"checked":true,"is_deleted":false}],"reminders":[]}""")
            }
        }.use { server ->
            signIn(server)
            showNotification()
            tapComplete()

            val waiting = notifications.getNotification("rem-00001", 1)
            assertNotNull("de melding blijft staan", waiting)
            assertEquals("Geen verbinding. De taak wordt voltooid zodra er weer verbinding is.", text(waiting))
            assertEquals("alleen uitstellen kan nog", listOf("Over 10 minuten", "Over 1 uur"), waiting.actions.map { it.title.toString() })
            assertEquals(setOf("rem-00001"), ReminderStore.load(app).pendingCompletes.keys)

            // nog steeds geen verbinding: blijft wachten, de melding blijft staan
            assertEquals(ListenableWorker.Result.retry(), worker().doWork())
            assertEquals(setOf("rem-00001"), ReminderStore.load(app).pendingCompletes.keys)
            assertNotNull(notifications.getNotification("rem-00001", 1))

            // de verbinding is terug
            online = true
            assertEquals(ListenableWorker.Result.success(), worker().doWork())
            val completes = server.requests.filter { it.body.contains("task_complete") }
            assertTrue("er is opnieuw geprobeerd", completes.size >= 3)
            val uuids = completes.map { Json.asObject(Json.parseObject(it.body)!!.list("commands")!!.single())!!["uuid"] }.toSet()
            assertEquals("elke poging gebruikt hetzelfde uuid", setOf<Any?>(uuid), uuids)
            assertTrue(ReminderStore.load(app).pendingCompletes.isEmpty())
            assertNull("de melding is weg", notifications.getNotification("rem-00001", 1))
        }
    }

    @Test
    fun `voltooien geweigerd - de melding blijft staan met een korte uitleg`() {
        FakeServer { request ->
            if (request.body.contains("task_complete")) {
                Response(200, """{"sync_status":{"$uuid":{"error_code":"NOT_FOUND","error":"task.id bestaat niet"}}}""")
            } else {
                Response(200, syncBody)
            }
        }.use { server ->
            signIn(server)
            showNotification()
            tapComplete()

            val rejected = notifications.getNotification("rem-00001", 1)
            assertNotNull(rejected)
            assertEquals("Voltooien is niet gelukt: de taak bestaat niet meer of je hebt er geen toegang meer toe.", text(rejected))
            assertEquals(listOf("Over 10 minuten", "Over 1 uur"), rejected.actions.map { it.title.toString() })
            assertTrue("een weigering proberen we niet opnieuw", ReminderStore.load(app).pendingCompletes.isEmpty())
        }
    }

    @Test
    fun `voltooien met een verlopen sessie - de melding vraagt om opnieuw in te loggen`() {
        FakeServer { Response(401, """{"error_code":"UNAUTHORIZED","error":"ongeldige of ontbrekende aanmelding"}""") }.use { server ->
            signIn(server)
            showNotification()
            tapComplete()

            assertEquals("Je bent afgemeld. Open de app en log opnieuw in om deze taak te voltooien.", text(notifications.getNotification("rem-00001", 1)))
            assertTrue(Prefs(app).sessionExpired)
            assertTrue(ReminderStore.load(app).pendingCompletes.isEmpty())
        }
    }

    @Test
    fun `voltooien dat drie dagen niet lukt, geven we op met een melding`() {
        FakeServer { Response(503, "") }.use { server ->
            signIn(server)
            showNotification()
            tapComplete()
            assertEquals(1, ReminderStore.load(app).pendingCompletes.size)

            AppClock.now = { trigger + 3 * 24 * 60 * minute + minute }
            worker().doWork()
            assertTrue(ReminderStore.load(app).pendingCompletes.isEmpty())
            assertEquals(
                "Voltooien is niet gelukt: de server is niet bereikbaar. Open de app om het opnieuw te proberen.",
                text(notifications.getNotification("rem-00001", 1)),
            )
        }
    }

    @Test
    fun `een knop zonder geldige gegevens doet niets`() {
        ActionReceiver().onReceive(app, Intent(app, ActionReceiver::class.java).setAction("io.github.wnijhof.tickory.action.COMPLETE"))
        ActionReceiver().onReceive(
            app,
            Intent(app, ActionReceiver::class.java).setAction("io.github.wnijhof.tickory.action.SNOOZE")
                .putExtra("io.github.wnijhof.tickory.extra.REMINDER_ID", "../raar id").putExtra("io.github.wnijhof.tickory.extra.TASK_ID", "task-0001"),
        )
        assertEquals(0, notifications.size())
        assertTrue(alarms.scheduledAlarms.isEmpty())
        assertTrue(ReminderStore.load(app).snoozed.isEmpty())
    }
}
