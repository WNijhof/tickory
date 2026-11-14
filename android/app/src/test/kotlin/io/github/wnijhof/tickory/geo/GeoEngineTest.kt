package io.github.wnijhof.tickory.geo

import android.Manifest
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import androidx.test.core.app.ApplicationProvider
import io.github.wnijhof.tickory.core.Fix
import io.github.wnijhof.tickory.core.GeoKind
import io.github.wnijhof.tickory.core.GeoPolicy
import io.github.wnijhof.tickory.core.PlaceInfo
import io.github.wnijhof.tickory.core.ReminderInfo
import io.github.wnijhof.tickory.core.ReminderState
import io.github.wnijhof.tickory.core.SyncSnapshot
import io.github.wnijhof.tickory.core.TaskInfo
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.ReminderEngine
import io.github.wnijhof.tickory.store.GeoStore
import io.github.wnijhof.tickory.store.ReminderStore
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

/** Een plaatsbepaling-bron die we zelf sturen. */
class FakeSource(var known: List<Fix> = emptyList(), var fresh: Fix? = null) : LocationSource {
    var freshCalls = 0
    override fun lastKnown(): List<Fix> = known
    override fun current(timeoutMs: Long): Fix? {
        freshCalls += 1
        return fresh
    }
}

/**
 * De locatiecontrole op een nagebootst Android: plaatsbepalingen erin, meldingen eruit. Alle plaatsen zijn verzonnen.
 * Wat hier niet onder valt: of een echt toestel positie levert, hoe nauwkeurig die is en hoe lang de batterij het volhoudt.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class GeoEngineTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val notifications get() = shadowOf(app.getSystemService(NotificationManager::class.java))
    private val locations get() = shadowOf(app.getSystemService(LocationManager::class.java))
    private val now = 1_900_000_000_000L
    private val home = PlaceInfo("place-home-1", "Thuis", 52.0, 5.0, 150)
    private val metersPerDegree = 111_195.0
    private lateinit var source: FakeSource

    private fun fix(meters: Double, secondsAfterStart: Long, accuracy: Float? = 15f) =
        Fix(home.lat + meters / metersPerDegree, home.lon, accuracy, now + secondsAfterStart * 1000)

    private fun loc(id: String, task: String, trigger: String, place: String = home.id) =
        ReminderInfo(id, task, "location", null, null, false, place, trigger)

    private fun store(
        reminders: List<ReminderInfo> = listOf(loc("rem-00001", "task-0001", "enter"), loc("rem-00002", "task-0001", "leave")),
        tasks: List<TaskInfo> = listOf(TaskInfo("task-0001", "Pakket ophalen", "2030-06-14T14:00")),
        places: List<PlaceInfo> = listOf(home),
    ) = ReminderStore.save(app, ReminderState(snapshot = SyncSnapshot(tasks, reminders, places)))

    @Before
    fun setUp() {
        AppClock.now = { now }
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        locations.setLocationEnabled(true)
        locations.setProviderEnabled(LocationManager.NETWORK_PROVIDER, true)
        locations.setProviderEnabled(LocationManager.GPS_PROVIDER, true)
        GeoStore.setEnabled(app, true)
        GeoStore.saveState(app, io.github.wnijhof.tickory.core.GeoState())
        GeoStore.setRegisteredCadence(app, null)
        source = FakeSource()
        GeoEngine.sourceFactory = { source }
        store()
    }

    @After
    fun tearDown() {
        AppClock.now = { System.currentTimeMillis() }
        GeoEngine.sourceFactory = { PlatformLocationSource(it) }
        GeoEngine.clear(app)
        GeoStore.setEnabled(app, false)
    }

    private fun shown(id: String): Notification? = notifications.getNotification(id, 1)

    /** Levert bepalingen af zoals Android dat doet: "nu" is het tijdstip van de nieuwste. */
    private fun feed(vararg fixes: Fix) {
        AppClock.now = { fixes.maxOf { it.atMs } }
        GeoEngine.onFixes(app, fixes.toList())
    }

    // ---------- aankomst en vertrek geven een melding ----------

    @Test
    fun `vertrek geeft de melding van de vertrek-herinnering, met dezelfde knoppen als een tijdherinnering`() {
        feed(fix(20.0, 0))
        assertEquals("de eerste bepaling is alleen vastleggen", 0, notifications.size())
        feed(fix(400.0, 600))

        val n = shown("rem-00002")
        assertNotNull("de vertrek-melding hoort er te staan", n)
        assertNull("de aankomst-herinnering gaat niet af bij vertrek", shown("rem-00001"))
        assertEquals("Pakket ophalen", n!!.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Je bent vertrokken bij Thuis", n.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(io.github.wnijhof.tickory.reminders.Notifications.CHANNEL_ID, n.channelId)
        assertEquals(Notification.CATEGORY_REMINDER, n.category)
        assertEquals(listOf("Voltooien", "Over 10 minuten", "Over 1 uur"), n.actions.map { it.title.toString() })
        assertEquals("task-0001", n.extras.getString(io.github.wnijhof.tickory.reminders.Notifications.EXTRA_TASK_ID))
    }

    @Test
    fun `aankomst geeft de melding van de aankomst-herinnering`() {
        feed(fix(900.0, 0))
        feed(fix(60.0, 600))
        assertNull(shown("rem-00002"))
        assertEquals("Je bent aangekomen bij Thuis", shown("rem-00001")!!.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
    }

    @Test
    fun `de melding komt per aankomst een keer, en bij de volgende aankomst weer`() {
        feed(fix(900.0, 0))
        feed(fix(60.0, 600))
        assertNotNull(shown("rem-00001"))
        app.getSystemService(NotificationManager::class.java).cancelAll()
        // dezelfde bepaling nog eens (dubbel afgeleverd), en blijven staan: niets
        feed(fix(60.0, 600))
        feed(fix(40.0, 900), fix(80.0, 1_200))
        assertEquals(0, notifications.size())
        // weg en weer terug: opnieuw
        feed(fix(800.0, 2_000))
        feed(fix(50.0, 3_000))
        assertNotNull(shown("rem-00001"))
    }

    @Test
    fun `meerdere bepalingen in een keer worden op volgorde van tijd verwerkt`() {
        // aangeleverd in de verkeerde volgorde: eerst buiten (vroeg), dan binnen (laat)
        feed(fix(50.0, 600), fix(900.0, 0))
        assertNotNull(shown("rem-00001"))
    }

    // ---------- wanneer niet ----------

    @Test
    fun `niet voor een afgevinkte of verwijderde taak`() {
        store(tasks = listOf(TaskInfo("task-0001", "Klaar", null, checked = true)))
        feed(fix(900.0, 0))
        feed(fix(50.0, 600))
        assertEquals(0, notifications.size())
        store(tasks = listOf(TaskInfo("task-0001", "Weg", null, deleted = true)))
        feed(fix(900.0, 1_200))
        feed(fix(50.0, 1_800))
        assertEquals(0, notifications.size())
    }

    @Test
    fun `een taak die tussen aankomst en melding wordt afgevinkt, geeft geen melding meer`() {
        feed(fix(900.0, 0))
        store(tasks = listOf(TaskInfo("task-0001", "Klaar", null, checked = true)))
        feed(fix(50.0, 600))
        assertEquals(0, notifications.size())
    }

    @Test
    fun `uitgezet door de gebruiker - er gebeurt niets`() {
        GeoStore.setEnabled(app, false)
        feed(fix(900.0, 0))
        feed(fix(50.0, 600))
        assertEquals(0, notifications.size())
        assertNull(GeoStore.loadState(app).lastFix)
    }

    @Test
    fun `een verwijderde plaats of herinnering geeft niets`() {
        store(places = emptyList())
        feed(fix(900.0, 0))
        feed(fix(50.0, 600))
        assertEquals(0, notifications.size())
        store(reminders = listOf(loc("rem-00001", "task-0001", "enter").copy(deleted = true)))
        feed(fix(900.0, 1_200))
        feed(fix(50.0, 1_800))
        assertEquals(0, notifications.size())
    }

    @Test
    fun `een herinnering die je maakt terwijl je al op de plek bent, gaat niet meteen af`() {
        store(reminders = emptyList())
        GeoEngine.onFixes(app, listOf(fix(30.0, 0))) // niets te bewaken, wel een positie
        store()
        source.known = listOf(fix(30.0, 60))
        GeoEngine.tick(app)
        assertEquals(0, notifications.size())
        assertEquals(true, GeoStore.loadState(app).tracks[home.id]?.inside)
    }

    // ---------- na een herstart ----------

    @Test
    fun `na een herstart van het toestel gaat het verder waar het was`() {
        feed(fix(30.0, 0))
        // het proces is weg: alles komt uit de opslag; een nieuwe `GeoEngine` bestaat niet, de opslag wel
        feed(fix(700.0, 7_200))
        assertNotNull("het vertrek van twee uur geleden wordt alsnog gemeld", shown("rem-00002"))
    }

    @Test
    fun `na meer dan twaalf uur zonder bepaling is een verandering geen nieuws meer`() {
        feed(fix(30.0, 0))
        AppClock.now = { now + 15 * 3600_000L }
        feed(fix(900.0, 15 * 3600L))
        assertEquals(0, notifications.size())
    }

    // ---------- tick: het zekerheidsnet en "Controleer nu" ----------

    @Test
    fun `tick verwerkt de laatst bekende positie van Android en vraagt geen verse als die jong genoeg is`() {
        feed(fix(900.0, 0))
        AppClock.now = { now + 120_000 }
        source.known = listOf(fix(50.0, 100))
        GeoEngine.tick(app)
        assertEquals("een verse bepaling is niet nodig", 0, source.freshCalls)
        assertNotNull(shown("rem-00001"))
    }

    @Test
    fun `tick vraagt zelf een verse bepaling als er te lang niets is`() {
        source.fresh = fix(900.0, 0)
        GeoEngine.tick(app)
        assertEquals(1, source.freshCalls)
        assertEquals(now, GeoStore.loadState(app).lastFix?.atMs)
    }

    @Test
    fun `controleer nu vraagt altijd een verse bepaling, ook zonder herinnering op een plek`() {
        store(reminders = emptyList())
        source.fresh = fix(300.0, 0)
        GeoEngine.tick(app, forceActive = true)
        assertEquals(1, source.freshCalls)
        assertEquals(now, GeoStore.loadState(app).lastCheckMs)
        GeoStore.setEnabled(app, false)
        GeoEngine.tick(app, forceActive = true)
        assertEquals("uitgezet: niets", 1, source.freshCalls)
    }

    @Test
    fun `tick doet niets als er niets te bewaken valt`() {
        store(reminders = emptyList())
        GeoEngine.tick(app)
        assertEquals(0, source.freshCalls)
    }

    // ---------- wanneer moet er gewaakt worden ----------

    @Test
    fun `wanted - alleen als alles klopt`() {
        assertTrue(GeoEngine.wanted(app))
        GeoStore.setEnabled(app, false)
        assertFalse("uitgezet", GeoEngine.wanted(app))
        GeoStore.setEnabled(app, true)
        locations.setLocationEnabled(false)
        assertFalse("locatie staat uit op het toestel", GeoEngine.wanted(app))
        locations.setLocationEnabled(true)
        store(reminders = emptyList())
        assertFalse("geen herinnering op een plek", GeoEngine.wanted(app))
        store(tasks = listOf(TaskInfo("task-0001", "Klaar", null, checked = true)))
        assertFalse("de taak is af", GeoEngine.wanted(app))
        store()
        shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        assertFalse("geen nauwkeurige locatie", GeoEngine.wanted(app))
    }

    // ---------- aanvragen bij Android ----------

    @Test
    fun `refresh vraagt passief en netwerk aan, met een frequentie die bij de afstand past`() {
        source.known = listOf(fix(5_000.0, 0))
        GeoEngine.refresh(app)
        val passive = locations.getLocationRequests(LocationManager.PASSIVE_PROVIDER)
        val network = locations.getLocationRequests(LocationManager.NETWORK_PROVIDER)
        assertEquals(1, passive.size)
        assertEquals(1, network.size)
        assertTrue("GPS niet continu aangevraagd", locations.getLocationRequests(LocationManager.GPS_PROVIDER).isEmpty())
        val expected = GeoPolicy.cadence(4_850.0)
        assertEquals(expected.minTimeMs, network[0].intervalMillis)
        assertEquals(expected.minDistanceM, network[0].minUpdateDistanceMeters, 0.5f)
        assertEquals(expected, GeoStore.registeredCadence(app))
    }

    @Test
    fun `dichterbij wordt vaker gevraagd`() {
        source.known = listOf(fix(5_000.0, 0))
        GeoEngine.refresh(app)
        val far = locations.getLocationRequests(LocationManager.NETWORK_PROVIDER)[0].intervalMillis
        AppClock.now = { now + 3_600_000 }
        feed(Fix(home.lat + 300.0 / metersPerDegree, home.lon, 15f, now + 3_600_000))
        val near = locations.getLocationRequests(LocationManager.NETWORK_PROVIDER)[0].intervalMillis
        assertTrue("$near < $far", near < far)
    }

    @Test
    fun `zonder netwerklocatie vraagt de app GPS aan, maar nooit vaker dan elke vijf minuten`() {
        locations.setProviderEnabled(LocationManager.NETWORK_PROVIDER, false)
        source.known = listOf(fix(300.0, 0))
        GeoEngine.refresh(app)
        val gps = locations.getLocationRequests(LocationManager.GPS_PROVIDER)
        assertEquals(1, gps.size)
        assertTrue(gps[0].intervalMillis >= 5 * 60_000L)
        assertTrue(locations.getLocationRequests(LocationManager.NETWORK_PROVIDER).isEmpty())
    }

    @Test
    fun `de aanvraag gaat naar de eigen ontvanger, met een intent die Android kan aanvullen`() {
        GeoEngine.refresh(app)
        val pi = locations.getLocationUpdatePendingIntents(LocationManager.NETWORK_PROVIDER).single()
        val saved = shadowOf(pi)
        assertTrue(saved.isBroadcast)
        assertEquals(GeoReceiver::class.java.name, saved.savedIntent.component?.className)
        assertEquals(GeoRegistrar.ACTION, saved.savedIntent.action)
        assertEquals(app.packageName, saved.savedIntent.component?.packageName)
        // de bronnen hebben elk een eigen adres, anders vervangt de tweede aanvraag de eerste
        val other = shadowOf(locations.getLocationUpdatePendingIntents(LocationManager.PASSIVE_PROVIDER).single())
        assertTrue(saved.savedIntent.dataString != other.savedIntent.dataString)
    }

    @Test
    fun `als er niets meer te bewaken is, stopt alles`() {
        GeoEngine.refresh(app)
        assertFalse(locations.getLocationUpdatePendingIntents().isEmpty())
        store(reminders = emptyList())
        GeoEngine.refresh(app)
        assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
        assertNull(GeoStore.registeredCadence(app))
    }

    @Test
    fun `uitzetten stopt alles en wist wat we wisten`() {
        source.known = listOf(fix(300.0, 0))
        GeoEngine.refresh(app)
        assertNotNull(GeoStore.loadState(app).lastFix)
        GeoEngine.setEnabled(app, false)
        assertTrue(locations.getLocationUpdatePendingIntents().isEmpty())
        assertNull(GeoStore.loadState(app).lastFix)
        assertFalse(GeoStore.enabled(app))
    }

    @Test
    fun `een plaats die uit de herinneringen verdwijnt, verdwijnt ook uit de toestand`() {
        feed(fix(30.0, 0))
        assertTrue(GeoStore.loadState(app).tracks.containsKey(home.id))
        store(reminders = emptyList())
        GeoEngine.refresh(app, check = false)
        assertTrue(GeoStore.loadState(app).tracks.isEmpty())
    }

    // ---------- de ontvanger ----------

    @Test
    fun `de ontvanger leest een positie uit de intent van Android en verwerkt hem`() {
        feed(fix(900.0, 0))
        val location = Location(LocationManager.NETWORK_PROVIDER).apply {
            latitude = home.lat + 50.0 / metersPerDegree
            longitude = home.lon
            accuracy = 12f
            time = now + 600_000
        }
        AppClock.now = { now + 600_000 }
        io.github.wnijhof.tickory.reminders.Background.executor = java.util.concurrent.Executor { it.run() }
        try {
            GeoReceiver().onReceive(app, Intent(GeoRegistrar.ACTION).putExtra(LocationManager.KEY_LOCATION_CHANGED, location))
        } finally {
            io.github.wnijhof.tickory.reminders.Background.executor = java.util.concurrent.Executors.newCachedThreadPool()
        }
        assertNotNull(shown("rem-00001"))
    }

    @Test
    fun `de ontvanger negeert een intent zonder positie of met een andere actie`() {
        io.github.wnijhof.tickory.reminders.Background.executor = java.util.concurrent.Executor { it.run() }
        try {
            GeoReceiver().onReceive(app, Intent(GeoRegistrar.ACTION))
            GeoReceiver().onReceive(app, Intent("een.andere.actie").putExtra(LocationManager.KEY_LOCATION_CHANGED, Location("x")))
        } finally {
            io.github.wnijhof.tickory.reminders.Background.executor = java.util.concurrent.Executors.newCachedThreadPool()
        }
        assertEquals(0, notifications.size())
        assertNull(GeoStore.loadState(app).lastFix)
        assertTrue(GeoRegistrar.fixesFrom(Intent()).isEmpty())
    }

    @Test
    fun `een positie zonder nauwkeurigheid of tijd krijgt de standaard`() {
        val bare = Location("gps").apply { latitude = 52.0; longitude = 5.0 }
        val fix = PlatformLocationSource.toFix(bare)
        assertNull(fix.accuracyM)
        assertEquals(now, fix.atMs)
    }

    // ---------- status voor de pagina ----------

    @Test
    fun `de status bevat afstanden en toestemmingen, nooit de eigen coordinaten`() {
        feed(fix(300.0, 0))
        val status = GeoEngine.status(app)
        assertEquals(true, status["enabled"])
        assertEquals(true, status["precise"])
        assertEquals(true, status["background"])
        assertEquals(true, status["needed"])
        assertEquals(now, status["lastCheckAt"])
        assertEquals(now, status["lastFixAt"])
        val place = (status["places"] as List<*>).single() as Map<*, *>
        assertEquals("place-home-1", place["id"])
        assertEquals(300L, place["distance"])
        assertEquals(false, place["inside"])
        val text = io.github.wnijhof.tickory.core.Json.stringify(status)
        assertFalse("geen coordinaten in de status: $text", text.contains("52.00") || text.contains("lat") || text.contains("lon\""))
    }

    @Test
    fun `de status van een toestel zonder toestemming`() {
        shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_BACKGROUND_LOCATION)
        val status = GeoEngine.status(app)
        assertEquals(false, status["precise"])
        assertEquals(false, status["background"])
        assertEquals(false, status["running"])
    }

    @Test
    fun `met alleen een benaderde locatie`() {
        shadowOf(app).denyPermissions(Manifest.permission.ACCESS_FINE_LOCATION)
        assertEquals(true, GeoEngine.status(app)["approximate"])
        assertFalse(GeoEngine.wanted(app))
    }

    // ---------- uitstellen en voltooien werken ook voor deze meldingen ----------

    @Test
    fun `uitstellen van een melding op een plek brengt dezelfde tekst terug`() {
        feed(fix(900.0, 0))
        feed(fix(50.0, 600))
        val reminder = io.github.wnijhof.tickory.core.PlannedReminder("rem-00001", "task-0001", "Pakket ophalen", now + 600_000, "2030-06-14T14:00", "Thuis", "enter")
        AppClock.now = { now + 700_000 }
        ReminderEngine.snooze(app, reminder)
        assertNull("de melding is weg tot het uitstel voorbij is", shown("rem-00001"))
        AppClock.now = { now + 700_000 + 11 * 60_000 }
        ReminderEngine.replan(app)
        assertEquals("Je bent aangekomen bij Thuis", shown("rem-00001")!!.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(GeoKind.ENTER, GeoKind.valueOf("ENTER"))
    }
}
