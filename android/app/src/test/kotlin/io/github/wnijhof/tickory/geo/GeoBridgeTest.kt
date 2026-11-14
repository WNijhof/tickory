package io.github.wnijhof.tickory.geo

import android.Manifest
import android.app.AlertDialog
import android.app.Application
import android.content.pm.PackageManager
import android.location.LocationManager
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.WebBridge
import io.github.wnijhof.tickory.core.Fix
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.PlaceInfo
import io.github.wnijhof.tickory.core.ReminderInfo
import io.github.wnijhof.tickory.core.ReminderState
import io.github.wnijhof.tickory.core.SyncSnapshot
import io.github.wnijhof.tickory.core.TaskInfo
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.GeoStore
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ReminderStore
import io.github.wnijhof.tickory.store.TokenVault
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlertDialog
import org.robolectric.shadows.ShadowToast
import java.util.concurrent.Executor
import javax.crypto.KeyGenerator

/**
 * De brug en de toestemmingen voor locatie op een nagebootst Android: wanneer de app uitleg toont, wanneer hij vraagt, hoe
 * hij omgaat met weigeren, en dat een vreemde pagina er niets mee kan. Wat hier niet onder valt: hoe Android de
 * toestemmingsschermen echt toont (op Android 11 en nieuwer gaat "Altijd toestaan" via het instellingenscherm).
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class GeoBridgeTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val origin = "https://taken.voorbeeld.nl"
    private val originalExecutor: Executor = Background.executor
    private val fine = Manifest.permission.ACCESS_FINE_LOCATION
    private val coarse = Manifest.permission.ACCESS_COARSE_LOCATION
    private val background = Manifest.permission.ACCESS_BACKGROUND_LOCATION
    private val metersPerDegree = 111_195.0
    private val home = PlaceInfo("place-home-1", "Thuis", 52.0, 5.0, 150)
    private lateinit var activity: MainActivity
    private lateinit var webView: WebView
    private lateinit var bridge: WebBridge

    @Before
    fun setUp() {
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        GeoStore.setEnabled(app, false)
        GeoStore.setDeclined(app, false)
        shadowOf(app.getSystemService(LocationManager::class.java)).setLocationEnabled(true)
        GeoEngine.sourceFactory = { FakeSource() }
        Prefs(app).setServer(origin, false)
        activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        webView = activity.findViewById<ViewGroup>(R.id.web_container).getChildAt(0) as WebView
        shadowOf(webView).webViewClient.onPageFinished(webView, "$origin/")
        bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
    }

    @After
    fun tearDown() {
        Background.executor = originalExecutor
        GeoEngine.sourceFactory = { PlatformLocationSource(it) }
        GeoEngine.clear(app)
        GeoStore.setEnabled(app, false)
    }

    private fun status() = Json.parseObject(bridge.locationStatus())!!

    private fun latestDialog(): AlertDialog = ShadowAlertDialog.getLatestAlertDialog()

    private fun click(dialog: AlertDialog, button: Int) {
        dialog.getButton(button).performClick()
        org.robolectric.shadows.ShadowLooper.idleMainLooper() // de knoppen van een dialoog werken via een bericht aan de hoofddraad
    }

    /** Wat Android doet na een toestemmingsvraag: de gevraagde rechten toekennen of weigeren en het antwoord afleveren. */
    private fun answer(grant: Set<String>) {
        val request = shadowOf(activity).lastRequestedPermission
        assertNotNull("er is om een toestemming gevraagd", request)
        for (p in request.requestedPermissions) {
            if (p in grant) shadowOf(app).grantPermissions(p) else shadowOf(app).denyPermissions(p)
        }
        val results = request.requestedPermissions.map { if (it in grant) PackageManager.PERMISSION_GRANTED else PackageManager.PERMISSION_DENIED }.toIntArray()
        activity.onRequestPermissionsResult(request.requestCode, request.requestedPermissions, results)
    }

    private fun store() = ReminderStore.save(
        app,
        ReminderState(
            snapshot = SyncSnapshot(
                listOf(TaskInfo("task-0001", "Pakket ophalen", null)),
                listOf(ReminderInfo("rem-00001", "task-0001", "location", null, null, false, home.id, "enter")),
                listOf(home),
            ),
        ),
    )

    // ---------- niets vragen zonder keuze van de gebruiker ----------

    @Test
    fun `bij het starten van de app wordt nergens om locatie gevraagd`() {
        assertNull("geen toestemmingsvraag", shadowOf(activity).lastRequestedPermission)
        assertNull("geen uitleg", ShadowAlertDialog.getLatestAlertDialog())
        assertEquals(false, status()["enabled"])
        assertEquals(false, status()["running"])
    }

    @Test
    fun `de status heeft een vaste vorm`() {
        val s = status()
        assertEquals(
            setOf("enabled", "precise", "approximate", "background", "servicesOn", "hasGps", "needed", "running", "declined", "lastCheckAt", "lastFixAt", "accuracy", "ignored", "places"),
            s.keys,
        )
    }

    // ---------- de stappen ----------

    @Test
    fun `eerst uitleg, dan nauwkeurige locatie, dan uitleg en Altijd toestaan`() {
        bridge.requestLocationPermission()
        val intro = latestDialog()
        assertEquals("Herinneringen op een plek", shadowOf(intro).title.toString())
        val message = shadowOf(intro).message.toString()
        assertTrue(message, message.contains("alleen op je telefoon") && message.contains("nooit naar je server") && message.contains("geen Google-diensten"))
        assertNull("nog niet gevraagd, eerst uitleg", shadowOf(activity).lastRequestedPermission)
        assertFalse("nog niet aangezet", GeoStore.enabled(app))

        click(intro, AlertDialog.BUTTON_POSITIVE)
        assertEquals(setOf(fine, coarse), shadowOf(activity).lastRequestedPermission.requestedPermissions.toSet())

        answer(setOf(fine, coarse))
        val second = latestDialog()
        assertEquals("Ook als de app dicht is", shadowOf(second).title.toString())
        assertTrue(shadowOf(second).message.toString().contains("Altijd toestaan"))
        click(second, AlertDialog.BUTTON_POSITIVE)
        assertEquals(listOf(background), shadowOf(activity).lastRequestedPermission.requestedPermissions.toList())

        answer(setOf(background))
        assertTrue(GeoStore.enabled(app))
        assertEquals(true, status()["precise"])
        assertEquals(true, status()["background"])
        assertEquals(false, status()["declined"])
        assertTrue(shadowOf(webView).lastEvaluatedJavascript.contains("tickory-android-status"))
    }

    @Test
    fun `annuleren bij de uitleg vraagt niets en zet niets aan`() {
        bridge.requestLocationPermission()
        click(latestDialog(), AlertDialog.BUTTON_NEGATIVE)
        assertNull(shadowOf(activity).lastRequestedPermission)
        assertFalse(GeoStore.enabled(app))
        assertFalse(GeoStore.declined(app))
    }

    @Test
    fun `weigeren van nauwkeurige locatie zet de controle uit en onthoudt het, zonder te blijven aandringen`() {
        bridge.requestLocationPermission()
        click(latestDialog(), AlertDialog.BUTTON_POSITIVE)
        answer(emptySet())
        assertFalse(GeoStore.enabled(app))
        assertTrue(GeoStore.declined(app))
        assertEquals(true, status()["declined"])
        assertEquals("Zonder toestemming voor locatie werken herinneringen op een plek niet. Je kunt dit later aanzetten bij Plaatsen.", ShadowToast.getTextOfLatestToast())
        assertNull("geen tweede vraag", ShadowAlertDialog.getLatestAlertDialog()?.takeIf { shadowOf(it).title.toString() == "Ook als de app dicht is" })
    }

    @Test
    fun `alleen een benaderde locatie is te grof en wordt ook zo uitgelegd`() {
        bridge.requestLocationPermission()
        click(latestDialog(), AlertDialog.BUTTON_POSITIVE)
        answer(setOf(coarse))
        assertFalse(GeoStore.enabled(app))
        assertEquals(true, status()["approximate"])
        assertTrue(ShadowToast.getTextOfLatestToast().contains("benaderde"))
    }

    @Test
    fun `zonder Altijd toestaan werkt het nog wel, met een uitleg`() {
        bridge.requestLocationPermission()
        click(latestDialog(), AlertDialog.BUTTON_POSITIVE)
        answer(setOf(fine, coarse))
        click(latestDialog(), AlertDialog.BUTTON_POSITIVE)
        answer(emptySet())
        assertTrue(GeoStore.enabled(app))
        assertEquals(false, status()["background"])
        assertTrue(ShadowToast.getTextOfLatestToast().contains("alleen terwijl Tickory open is"))
    }

    @Test
    fun `later bij Altijd toestaan zet de controle toch aan`() {
        bridge.requestLocationPermission()
        click(latestDialog(), AlertDialog.BUTTON_POSITIVE)
        answer(setOf(fine, coarse))
        click(latestDialog(), AlertDialog.BUTTON_NEGATIVE)
        assertTrue(GeoStore.enabled(app))
    }

    @Test
    fun `staat alles al goed, dan zet de brug alleen de controle aan zonder vragen`() {
        shadowOf(app).grantPermissions(fine, coarse, background)
        bridge.requestLocationPermission()
        assertNull(ShadowAlertDialog.getLatestAlertDialog())
        assertNull(shadowOf(activity).lastRequestedPermission)
        assertTrue(GeoStore.enabled(app))
    }

    @Test
    fun `staat locatie uit op het toestel, dan wijst de app daarop`() {
        shadowOf(app.getSystemService(LocationManager::class.java)).setLocationEnabled(false)
        bridge.requestLocationPermission()
        click(latestDialog(), AlertDialog.BUTTON_POSITIVE)
        assertTrue(ShadowToast.getTextOfLatestToast().contains("Locatie staat uit"))
        assertEquals(false, status()["servicesOn"])
    }

    // ---------- aan- en uitzetten ----------

    @Test
    fun `uitzetten stopt alles`() {
        shadowOf(app).grantPermissions(fine, coarse, background)
        store()
        bridge.setLocationEnabled(true)
        assertTrue(GeoStore.enabled(app))
        assertTrue(shadowOf(app.getSystemService(LocationManager::class.java)).getLocationUpdatePendingIntents().isNotEmpty())
        bridge.setLocationEnabled(false)
        assertFalse(GeoStore.enabled(app))
        assertTrue(shadowOf(app.getSystemService(LocationManager::class.java)).getLocationUpdatePendingIntents().isEmpty())
    }

    @Test
    fun `controleer nu neemt een positie en de status laat de afstand tot je plaatsen zien`() {
        shadowOf(app).grantPermissions(fine, coarse, background)
        store()
        GeoStore.setEnabled(app, true)
        val now = 1_900_000_000_000L
        AppClock.now = { now }
        try {
            GeoEngine.sourceFactory = { FakeSource(fresh = Fix(52.0 + 400.0 / metersPerDegree, 5.0, 12f, now)) }
            bridge.checkLocationNow()
            val s = status()
            assertEquals(now, s["lastCheckAt"])
            assertEquals(12L, (s["accuracy"] as Number).toLong())
            val place = (s["places"] as List<*>).single() as Map<*, *>
            assertEquals(400L, place["distance"])
            assertTrue(shadowOf(webView).lastEvaluatedJavascript.contains("tickory-android-status"))
        } finally {
            AppClock.now = { System.currentTimeMillis() }
        }
    }

    // ---------- de huidige positie ----------

    @Test
    fun `de huidige positie - eerst toestemming, dan een gebeurtenis in de pagina met alleen getallen`() {
        val now = 1_900_000_000_000L
        AppClock.now = { now }
        try {
            GeoEngine.sourceFactory = { FakeSource(fresh = Fix(52.1234, 5.4321, 8f, now)) }
            bridge.requestCurrentPosition()
            assertEquals(setOf(fine, coarse), shadowOf(activity).lastRequestedPermission.requestedPermissions.toSet())
            assertNull("hier hoort geen uitleg bij: de gebruiker tikte zelf op de knop", ShadowAlertDialog.getLatestAlertDialog())
            answer(setOf(fine, coarse))
            val script = shadowOf(webView).lastEvaluatedJavascript
            assertEquals("window.dispatchEvent(new CustomEvent(\"tickory-position\",{detail:{lat:52.1234,lon:5.4321,accuracy:8.0}}));", script)
            assertFalse("de controle is hierdoor niet aangezet", GeoStore.enabled(app))
        } finally {
            AppClock.now = { System.currentTimeMillis() }
        }
    }

    @Test
    fun `de huidige positie - geweigerd of niet te bepalen geeft een fout`() {
        bridge.requestCurrentPosition()
        answer(emptySet())
        assertTrue(shadowOf(webView).lastEvaluatedJavascript.contains("error:\"denied\""))
        shadowOf(app).grantPermissions(fine)
        GeoEngine.sourceFactory = { FakeSource() }
        bridge.requestCurrentPosition()
        assertTrue(shadowOf(webView).lastEvaluatedJavascript, shadowOf(webView).lastEvaluatedJavascript.contains("error:\"timeout\""))
    }

    // ---------- een vreemde pagina ----------

    @Test
    fun `een vreemde pagina kan niets aanzetten, vragen of uitlezen`() {
        for (foreign in listOf("https://kwaad.voorbeeld.org/", "http://taken.voorbeeld.nl/", "about:blank")) {
            webView.loadUrl(foreign)
            assertEquals(foreign, "{}", bridge.locationStatus())
            bridge.requestLocationPermission()
            bridge.setLocationEnabled(true)
            bridge.checkLocationNow()
            bridge.openLocationSettings()
            bridge.requestCurrentPosition()
            assertNull(foreign, ShadowAlertDialog.getLatestAlertDialog())
            assertNull(foreign, shadowOf(activity).lastRequestedPermission)
            assertFalse(foreign, GeoStore.enabled(app))
        }
    }
}
