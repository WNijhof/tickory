package io.github.wnijhof.tickory.geo

import android.Manifest
import android.app.Application
import android.app.NotificationManager
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.ListenableWorker
import androidx.work.WorkInfo
import androidx.work.WorkManager
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.TestListenableWorkerBuilder
import androidx.work.testing.TestWorkerBuilder
import androidx.work.testing.WorkManagerTestInitHelper
import androidx.work.workDataOf
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Fix
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.reminders.SystemEventsReceiver
import io.github.wnijhof.tickory.store.GeoStore
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ReminderStore
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncWorker
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
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import javax.crypto.KeyGenerator

/** De onderdelen van de locatiecontrole die aan Android hangen, en hoe ze met aanmelden, verversen en opstarten samenwerken. */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class GeoPlatformTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val locations get() = shadowOf(app.getSystemService(LocationManager::class.java))
    private val notifications get() = shadowOf(app.getSystemService(NotificationManager::class.java))
    private val originalExecutor: Executor = Background.executor
    private val now = 1_900_000_000_000L
    private val token = "tky_test-token_0123456789-ABCDEFGHIJ"
    private val metersPerDegree = 111_195.0

    private val syncBody = """{"sync_token":"9","sync_status":{},
        "tasks":[{"id":"task-0001","content":"Pakket ophalen","due":null,"checked":false,"is_deleted":false}],
        "reminders":[{"id":"rem-00001","task_id":"task-0001","type":"location","minute_offset":null,"due":null,"place_id":"place-home-1","trigger":"leave","is_deleted":false}],
        "places":[{"id":"place-home-1","name":"Thuis","lat":52.0,"lon":5.0,"radius":150,"is_deleted":false}]}"""

    @Before
    fun setUp() {
        AppClock.now = { now }
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        locations.setLocationEnabled(true)
        locations.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
        locations.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        GeoStore.setEnabled(app, true)
        GeoEngine.sourceFactory = { FakeSource() }
    }

    @After
    fun tearDown() {
        AppClock.now = { System.currentTimeMillis() }
        Background.executor = originalExecutor
        GeoEngine.sourceFactory = { PlatformLocationSource(it) }
        GeoEngine.clear(app)
        GeoStore.setEnabled(app, false)
    }

    private fun fix(meters: Double, seconds: Long = 0) = Fix(52.0 + meters / metersPerDegree, 5.0, 15f, now + seconds * 1000)

    private fun syncWorker(): SyncWorker =
        TestWorkerBuilder.from(app, SyncWorker::class.java, Executors.newSingleThreadExecutor()).setInputData(workDataOf(SyncWorker.KEY_PERIODIC to true)).build()

    private fun work(name: String): List<WorkInfo> = WorkManager.getInstance(app).getWorkInfosForUniqueWork(name).get()

    // ---------- de gewone locatiedienst van Android ----------

    @Test
    fun `laatst bekende posities van alle bronnen`() {
        fun loc(provider: String, lat: Double, accuracy: Float) = Location(provider).apply { latitude = lat; longitude = 5.0; this.accuracy = accuracy; time = now - 30_000 }
        locations.setLastKnownLocation(LocationManager.GPS_PROVIDER, loc("gps", 52.0, 5f))
        locations.setLastKnownLocation(LocationManager.NETWORK_PROVIDER, loc("network", 52.001, 40f))
        val fixes = PlatformLocationSource(app).lastKnown()
        assertEquals(2, fixes.size)
        assertEquals(setOf(5f, 40f), fixes.map { it.accuracyM }.toSet())
        assertTrue(fixes.all { it.atMs == now - 30_000 })
    }

    @Test
    fun `zonder toestemming of zonder bronnen geeft de locatiedienst niets en geen fout`() {
        shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION)
        assertTrue(PlatformLocationSource(app).lastKnown().isEmpty())
        assertNull(PlatformLocationSource(app).current(200))
    }

    @Test
    fun `een verse bepaling zonder antwoord geeft na de wachttijd niets terug`() {
        locations.setProviderEnabled(LocationManager.GPS_PROVIDER, false)
        locations.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
        assertNull(PlatformLocationSource(app).current(100))
    }

    @Test
    fun `een verse bepaling van het netwerk`() {
        val result = java.util.concurrent.atomic.AtomicReference<Fix?>()
        val thread = Thread { result.set(PlatformLocationSource(app).current(8_000)) }
        thread.start()
        // wachten tot de aanvraag er is, dan het toestel een positie laten doorgeven
        val deadline = System.currentTimeMillis() + 5_000
        while (locations.getLocationRequests(LocationManager.NETWORK_PROVIDER).isEmpty() && System.currentTimeMillis() < deadline) Thread.sleep(10)
        locations.simulateLocation(Location(LocationManager.NETWORK_PROVIDER).apply { latitude = 52.5; longitude = 5.5; accuracy = 33f; time = now })
        thread.join(8_000)
        val fix = result.get()
        assertNotNull("een verse bepaling", fix)
        assertEquals(52.5, fix!!.lat, 1e-9)
        assertEquals(33f, fix.accuracyM!!, 0f)
    }

    // ---------- het zekerheidsnet ----------

    @Test
    fun `het zekerheidsnet vraagt zelf een positie en meldt wat er gebeurd is`() {
        ReminderStore.save(app, io.github.wnijhof.tickory.core.SyncParser.parseSnapshot(syncBody)!!.let { io.github.wnijhof.tickory.core.ReminderState(snapshot = it.trimmed()) })
        val source = FakeSource(known = listOf(fix(30.0)))
        GeoEngine.sourceFactory = { source }
        val worker = TestListenableWorkerBuilder<GeoWorker>(app).build()
        assertEquals(ListenableWorker.Result.success(), worker.doWork())
        assertEquals(true, GeoStore.loadState(app).tracks["place-home-1"]?.inside)

        AppClock.now = { now + 1_800_000 }
        source.known = emptyList()
        source.fresh = Fix(52.0 + 600.0 / metersPerDegree, 5.0, 15f, now + 1_800_000)
        assertEquals(ListenableWorker.Result.success(), TestListenableWorkerBuilder<GeoWorker>(app).build().doWork())
        assertEquals("een verse GPS-bepaling is gevraagd omdat de laatste te oud was", 1, source.freshCalls)
        assertNotNull(notifications.getNotification("rem-00001", 1))
    }

    @Test
    fun `het zekerheidsnet stopt zichzelf als er niets te bewaken valt`() {
        GeoScheduler.ensure(app)
        assertEquals(WorkInfo.State.ENQUEUED, work("tickory-geo-safety-net").single().state)
        assertEquals("elk kwartier", 15 * 60_000L, work("tickory-geo-safety-net").single().periodicityInfo?.repeatIntervalMillis)
        assertEquals(ListenableWorker.Result.success(), TestListenableWorkerBuilder<GeoWorker>(app).build().doWork())
        assertTrue(work("tickory-geo-safety-net").all { it.state == WorkInfo.State.CANCELLED })
    }

    @Test
    fun `het zekerheidsnet heeft geen netwerk nodig`() {
        GeoScheduler.ensure(app)
        assertEquals(androidx.work.NetworkType.NOT_REQUIRED, work("tickory-geo-safety-net").single().constraints.requiredNetworkType)
    }

    // ---------- verversen, opstarten en afmelden ----------

    @Test
    fun `na een verversing met een herinnering op een plek staat de controle aan, ook het zekerheidsnet`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            Prefs(app).setServer(server.origin, false)
            Session.set(app, token)
            GeoEngine.sourceFactory = { FakeSource(known = listOf(fix(30.0))) }
            assertEquals(ListenableWorker.Result.success(), syncWorker().doWork())

            assertEquals(listOf("tasks", "reminders", "projects", "sections", "labels", "places"), io.github.wnijhof.tickory.core.Json.parseObject(server.requests.last().body)!!.let { (it["resource_types"] as List<*>) })
            assertEquals(listOf("place-home-1"), ReminderStore.load(app).snapshot.places.map { it.id })
            assertTrue("er wordt bij Android om posities gevraagd", locations.getLocationUpdatePendingIntents().isNotEmpty())
            assertEquals(WorkInfo.State.ENQUEUED, work("tickory-geo-safety-net").single().state)
            assertEquals("de beginsituatie is vastgelegd: je bent thuis", true, GeoStore.loadState(app).tracks["place-home-1"]?.inside)
        }
    }

    @Test
    fun `een verversing zonder herinneringen op een plek vraagt niets aan`() {
        FakeServer { Response(200, """{"sync_token":"9","tasks":[],"reminders":[],"places":[]}""") }.use { server ->
            Prefs(app).setServer(server.origin, false)
            Session.set(app, token)
            assertEquals(ListenableWorker.Result.success(), syncWorker().doWork())
            assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
            assertTrue(work("tickory-geo-safety-net").isEmpty())
        }
    }

    @Test
    fun `afmelden stopt de controle en wist wat we wisten`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            Prefs(app).setServer(server.origin, false)
            Session.set(app, token)
            GeoEngine.sourceFactory = { FakeSource(known = listOf(fix(30.0))) }
            syncWorker().doWork()
            assertTrue(locations.getLocationUpdatePendingIntents().isNotEmpty())

            Session.set(app, "")

            assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
            assertNull(GeoStore.loadState(app).lastFix)
            assertTrue(GeoStore.loadState(app).tracks.isEmpty())
            assertTrue(ReminderStore.load(app).snapshot.places.isEmpty())
            assertTrue(work("tickory-geo-safety-net").all { it.state == WorkInfo.State.CANCELLED })
            assertTrue("de keuze van de gebruiker blijft staan", GeoStore.enabled(app))
        }
    }

    @Test
    fun `een andere gebruiker begint zonder de plaatsen van de vorige`() {
        FakeServer { Response(200, syncBody) }.use { server ->
            Prefs(app).setServer(server.origin, false)
            Session.set(app, token)
            GeoEngine.sourceFactory = { FakeSource(known = listOf(fix(30.0))) }
            syncWorker().doWork()
            assertTrue(GeoStore.loadState(app).tracks.isNotEmpty())
            Session.set(app, "tky_een-andere-gebruiker_9876543210")
            assertTrue(GeoStore.loadState(app).tracks.isEmpty())
            assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
        }
    }

    @Test
    fun `na het opstarten van het toestel worden de aanvragen bij Android opnieuw gedaan, zonder te wachten op een positie`() {
        ReminderStore.save(app, io.github.wnijhof.tickory.core.ReminderState(snapshot = io.github.wnijhof.tickory.core.SyncParser.parseSnapshot(syncBody)!!.trimmed()))
        // het toestel is opnieuw gestart: bij Android staat niets meer, de opslag van de app wel
        assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
        val source = FakeSource(fresh = fix(30.0))
        GeoEngine.sourceFactory = { source }
        SystemEventsReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertTrue(locations.getLocationUpdatePendingIntents().isNotEmpty())
        assertEquals("op de hoofddraad van de ontvanger geen GPS afwachten", 0, source.freshCalls)
        assertEquals(WorkInfo.State.ENQUEUED, work("tickory-geo-safety-net").single().state)
    }

    @Test
    fun `na het opstarten zonder herinneringen op een plek gebeurt er niets`() {
        SystemEventsReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
        assertFalse(work("tickory-geo-safety-net").isNotEmpty())
    }

    @Test
    fun `een toestemming die is ingetrokken stopt de aanvraag zonder fout`() {
        ReminderStore.save(app, io.github.wnijhof.tickory.core.ReminderState(snapshot = io.github.wnijhof.tickory.core.SyncParser.parseSnapshot(syncBody)!!.trimmed()))
        GeoEngine.refresh(app, check = false)
        assertTrue(locations.getLocationUpdatePendingIntents().isNotEmpty())
        shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        GeoEngine.refresh(app, check = false)
        assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
        assertEquals(false, GeoEngine.status(app)["running"].let { it == true && GeoEngine.wanted(app) })
    }
}
