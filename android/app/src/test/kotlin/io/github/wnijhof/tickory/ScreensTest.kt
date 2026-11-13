package io.github.wnijhof.tickory

import android.app.Application
import android.content.Intent
import android.net.Uri
import android.view.View
import android.view.ViewGroup
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.core.view.isVisible
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.reminders.Notifications
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
import java.util.concurrent.Executor
import javax.crypto.KeyGenerator

/**
 * De twee schermen en de brug op een nagebootst Android (Robolectric). De WebView is hier een attrappe: hij onthoudt
 * welk adres hij moest laden en welke instellingen hij kreeg, maar toont niets. Wat hier dus niet onder valt, is of
 * de web-app op een echt toestel goed in beeld komt.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class ScreensTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val origin = "https://taken.voorbeeld.nl"
    private val originalExecutor: Executor = Background.executor

    @Before
    fun setUp() {
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
    }

    @After
    fun tearDown() {
        Background.executor = originalExecutor
    }

    private fun main(intent: Intent? = null): MainActivity {
        Prefs(app).setServer(origin, false)
        val controller = if (intent != null) Robolectric.buildActivity(MainActivity::class.java, intent) else Robolectric.buildActivity(MainActivity::class.java)
        return controller.setup().get()
    }

    private fun webViewOf(activity: MainActivity): WebView = activity.findViewById<ViewGroup>(R.id.web_container).getChildAt(0) as WebView

    private fun request(url: String, mainFrame: Boolean = true, gesture: Boolean = true) = object : WebResourceRequest {
        override fun getUrl(): Uri = Uri.parse(url)
        override fun isForMainFrame(): Boolean = mainFrame
        override fun isRedirect(): Boolean = false
        override fun hasGesture(): Boolean = gesture
        override fun getMethod(): String = "GET"
        override fun getRequestHeaders(): Map<String, String> = emptyMap()
    }

    // ---------- hoofdscherm ----------

    @Test
    fun `zonder ingestelde server opent de app het instelscherm`() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).create().get()
        assertTrue(activity.isFinishing)
        assertEquals(SetupActivity::class.java.name, shadowOf(activity).nextStartedActivity.component?.className)
    }

    @Test
    fun `met een server laadt de web-app, met de afgesproken instellingen van de WebView`() {
        val activity = main()
        val webView = webViewOf(activity)
        assertEquals("$origin/", shadowOf(webView).lastLoadedUrl)

        val settings = webView.settings
        assertTrue(settings.javaScriptEnabled)
        assertTrue(settings.domStorageEnabled)
        assertFalse("geen toegang tot bestanden", settings.allowFileAccess)
        assertFalse("geen toegang tot content-adressen", settings.allowContentAccess)
        assertEquals("nooit gemengde inhoud", WebSettings.MIXED_CONTENT_NEVER_ALLOW, settings.mixedContentMode)
        assertFalse("geen meerdere vensters", settings.supportMultipleWindows())
        assertFalse(settings.javaScriptCanOpenWindowsAutomatically)

        assertTrue("de brug heet TickoryAndroid", shadowOf(webView).getJavascriptInterface("TickoryAndroid") is WebBridge)
        assertFalse("het foutscherm is niet in beeld", activity.findViewById<View>(R.id.error_view).isVisible)
    }

    @Test
    fun `een melding opent de app bij de taak`() {
        val intent = Intent(app, MainActivity::class.java).putExtra(Notifications.EXTRA_TASK_ID, "task-0001")
        assertEquals("$origin/#task=task-0001", shadowOf(webViewOf(main(intent))).lastLoadedUrl)
    }

    @Test
    fun `een taak-id met rare tekens wordt genegeerd`() {
        for (bad in listOf("x';alert(1);'", "a b", "../x", "a#b", "")) {
            val intent = Intent(app, MainActivity::class.java).putExtra(Notifications.EXTRA_TASK_ID, bad)
            assertEquals("'$bad'", "$origin/", shadowOf(webViewOf(main(intent))).lastLoadedUrl)
        }
    }

    @Test
    fun `staat de web-app al open, dan verandert een melding alleen het fragment`() {
        Prefs(app).setServer(origin, false)
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val webView = webViewOf(controller.get())
        shadowOf(webView).webViewClient.onPageFinished(webView, "$origin/") // de pagina is geladen

        controller.newIntent(Intent(app, MainActivity::class.java).putExtra(Notifications.EXTRA_TASK_ID, "task-0002"))

        assertEquals("er is niet opnieuw geladen", "$origin/", shadowOf(webView).lastLoadedUrl)
        val script = shadowOf(webView).lastEvaluatedJavascript
        assertNotNull(script)
        assertTrue(script, script.contains("'#task=task-0002'") && script.contains("location.hash=h"))
    }

    @Test
    fun `navigatie blijft binnen de eigen server, andere links gaan naar de browser`() {
        val activity = main()
        val webView = webViewOf(activity)
        val client = shadowOf(webView).webViewClient
        client.onPageFinished(webView, "$origin/")

        assertFalse("eigen server: gewoon laden", client.shouldOverrideUrlLoading(webView, request("$origin/pad?x=1#y")))

        assertTrue("andere site: niet in de app laden", client.shouldOverrideUrlLoading(webView, request("https://voorbeeld.org/pagina")))
        val started = shadowOf(activity).nextStartedActivity
        assertEquals(Intent.ACTION_VIEW, started.action)
        assertEquals("https://voorbeeld.org/pagina", started.dataString)

        // lijkt op de eigen server, maar is het niet
        for (lookalike in listOf("http://taken.voorbeeld.nl/", "https://taken.voorbeeld.nl.kwaad.com/", "https://taken.voorbeeld.nl@kwaad.com/", "https://taken.voorbeeld.nl:8443/")) {
            assertTrue(lookalike, client.shouldOverrideUrlLoading(webView, request(lookalike, gesture = false)))
        }
        assertNull("zonder tik van de gebruiker gaat er niets naar de browser", shadowOf(activity).nextStartedActivity)

        // een ingesloten kader van een andere site wordt geblokkeerd en opent niets
        assertTrue(client.shouldOverrideUrlLoading(webView, request("https://voorbeeld.org/kader", mainFrame = false)))
        assertNull(shadowOf(activity).nextStartedActivity)

        // gevaarlijke soorten adressen gaan nergens heen
        assertTrue(client.shouldOverrideUrlLoading(webView, request("intent://scan/#Intent;scheme=zxing;end")))
        assertTrue(client.shouldOverrideUrlLoading(webView, request("file:///sdcard/geheim.txt")))
        assertNull(shadowOf(activity).nextStartedActivity)
    }

    @Test
    fun `een hele pagina van buiten de eigen server laadt nooit, ook niet via een formulier`() {
        // Voor een formulier dat met POST naar een ander adres gaat, vraagt de WebView het vorige slot niet; dit wel.
        val webView = webViewOf(main())
        val client = shadowOf(webView).webViewClient

        assertNull("de eigen server: gewoon laden", client.shouldInterceptRequest(webView, request("$origin/")))
        assertNull(client.shouldInterceptRequest(webView, request("$origin/api/v1/sync")))

        for (foreign in listOf("https://kwaad.voorbeeld.org/formulier", "http://taken.voorbeeld.nl/", "https://taken.voorbeeld.nl.kwaad.com/")) {
            val blocked = client.shouldInterceptRequest(webView, request(foreign))
            assertNotNull("$foreign hoort een leeg antwoord te krijgen", blocked)
            assertEquals(0, blocked!!.data.readBytes().size)
        }

        // onderdelen van de eigen pagina (plaatjes, scripts) lopen hier niet doorheen; daarvoor zorgt het beleid van de server zelf
        assertNull(client.shouldInterceptRequest(webView, request("https://voorbeeld.org/plaatje.png", mainFrame = false)))
        // adressen die bij de pagina zelf horen
        assertNull(client.shouldInterceptRequest(webView, request("about:blank")))
        assertNull(client.shouldInterceptRequest(webView, request("blob:$origin/3f0c1d2e")))
    }

    @Test
    fun `lukt het laden niet, dan komt het eigen foutscherm met opnieuw proberen en serveradres wijzigen`() {
        val activity = main()
        val webView = webViewOf(activity)
        val client = shadowOf(webView).webViewClient
        val errorView = activity.findViewById<View>(R.id.error_view)

        client.onPageStarted(webView, "$origin/", null)
        client.onReceivedHttpError(webView, request("$origin/"), WebResourceResponse("text/html", "utf-8", 502, "Bad Gateway", emptyMap(), null))
        client.onPageFinished(webView, "$origin/") // komt ook na een fout, en mag het foutscherm dan niet weghalen

        assertTrue(errorView.isVisible)
        assertEquals("Geen verbinding met je server", activity.findViewById<TextView>(R.id.error_title).text.toString())
        assertEquals("De server op $origin gaf een fout (502).", activity.findViewById<TextView>(R.id.error_message).text.toString())
        assertEquals("Opnieuw proberen", activity.findViewById<Button>(R.id.error_retry).text.toString())
        assertEquals("Serveradres wijzigen", activity.findViewById<Button>(R.id.error_change_server).text.toString())

        // een fout in een plaatje of script is geen reden voor het foutscherm
        activity.findViewById<Button>(R.id.error_retry).performClick()
        assertFalse("opnieuw proberen haalt het foutscherm weg", errorView.isVisible)
        client.onReceivedHttpError(webView, request("$origin/icon.svg", mainFrame = false), WebResourceResponse("text/html", "utf-8", 404, "Not Found", emptyMap(), null))
        assertFalse(errorView.isVisible)
    }

    // ---------- de brug ----------

    @Test
    fun `de brug werkt alleen voor een pagina van de ingestelde server`() {
        val activity = main()
        val webView = webViewOf(activity)
        val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge

        // de eigen server staat geladen
        val status = Json.parseObject(bridge.notificationStatus())!!
        assertEquals(setOf("notifications", "exactAlarms", "batteryOptimized", "appVersion"), status.keys)
        assertTrue(status["notifications"] is Boolean && status["exactAlarms"] is Boolean && status["batteryOptimized"] is Boolean)
        assertEquals(BuildConfig.VERSION_NAME, status["appVersion"])
        bridge.setSession("tky_test-token_0123456789")
        assertEquals("tky_test-token_0123456789", TokenVault.load(app))

        // er staat een andere site geladen (zou niet mogen gebeuren, maar als het gebeurt doet de brug niets)
        for (foreign in listOf("https://kwaad.voorbeeld.org/", "http://taken.voorbeeld.nl/", "about:blank", "data:text/html,<p>x</p>")) {
            webView.loadUrl(foreign)
            assertEquals(foreign, "{}", bridge.notificationStatus())
            bridge.setSession("") // zou afmelden zijn
            bridge.setSession("tky_van-een-vreemde-pagina")
            bridge.remindersChanged()
            bridge.changeServer()
            assertEquals("het token is niet aangeraakt ($foreign)", "tky_test-token_0123456789", TokenVault.load(app))
        }
        assertEquals("de server is niet gewijzigd", origin, Prefs(app).serverOrigin)

        // terug op de eigen server: afmelden werkt weer
        webView.loadUrl("$origin/")
        bridge.setSession("")
        assertNull(TokenVault.load(app))
    }

    // ---------- instelscherm ----------

    private fun setup(): SetupActivity = Robolectric.buildActivity(SetupActivity::class.java).setup().get()

    private fun connect(activity: SetupActivity, address: String) {
        activity.findViewById<EditText>(R.id.address).setText(address)
        activity.findViewById<Button>(R.id.connect).performClick()
    }

    private fun errorOf(activity: SetupActivity): String? = activity.findViewById<TextView>(R.id.error).takeIf { it.isVisible }?.text?.toString()

    @Test
    fun `instelscherm - teksten en de waarschuwing bij http`() {
        val activity = setup()
        assertEquals("Verbinden", activity.findViewById<Button>(R.id.connect).text.toString())
        val warning = activity.findViewById<TextView>(R.id.http_warning)
        assertFalse(warning.isVisible)

        activity.findViewById<EditText>(R.id.address).setText("http://192.168.1.10:8787")
        assertTrue("bij http hoort de waarschuwing in beeld te komen", warning.isVisible)
        assertEquals("Let op: met http is de verbinding niet versleuteld. Gebruik dit alleen op je eigen thuisnetwerk.", warning.text.toString())

        activity.findViewById<EditText>(R.id.address).setText("https://taken.voorbeeld.nl")
        assertFalse(warning.isVisible)
    }

    @Test
    fun `instelscherm - ongeldige adressen geven een begrijpelijke melding en er wordt niets bewaard`() {
        val activity = setup()
        connect(activity, "")
        assertEquals("Vul het adres van je server in.", errorOf(activity))
        connect(activity, "ftp://taken.voorbeeld.nl")
        assertEquals("Het adres moet beginnen met https:// of http://.", errorOf(activity))
        connect(activity, "https://anna:geheim@taken.voorbeeld.nl")
        assertEquals("Zet geen gebruikersnaam of wachtwoord in het adres. Inloggen doe je daarna in de app.", errorOf(activity))
        connect(activity, "https://taken voorbeeld.nl")
        assertEquals("Dit is geen geldig adres. Controleer het op typfouten.", errorOf(activity))
        assertNull(Prefs(app).serverOrigin)
    }

    @Test
    fun `instelscherm - een Tickory-server wordt bewaard als oorsprong en de app gaat door`() {
        FakeServer { Response(200, """{"ok":true}""") }.use { server ->
            val activity = setup()
            connect(activity, "${server.origin}/een/pad?x=1")

            assertEquals("/health", server.requests.single().path)
            assertEquals("alleen de oorsprong, zonder pad", server.origin, Prefs(app).serverOrigin)
            assertEquals(MainActivity::class.java.name, shadowOf(activity).nextStartedActivity.component?.className)
            assertTrue(activity.isFinishing)
        }
    }

    @Test
    fun `instelscherm - geen Tickory-server, geen verbinding, en https proberen op een http-server`() {
        FakeServer { Response(404, "niet gevonden") }.use { server ->
            val activity = setup()
            connect(activity, server.origin)
            assertEquals("Op dit adres draait geen Tickory-server (antwoord 404).", errorOf(activity))
            assertTrue("de knop is weer te gebruiken", activity.findViewById<Button>(R.id.connect).isEnabled)
            assertNull(Prefs(app).serverOrigin)

            // zonder "http://" ervoor proberen we https; dat lukt hier niet, en de melding zegt wat je dan doet
            connect(activity, server.origin.removePrefix("http://"))
            val message = errorOf(activity)
            assertNotNull(message)
            assertTrue(message, message!!.contains("Draait je server zonder https? Zet dan http:// voor het adres."))
            assertNull(Prefs(app).serverOrigin)
        }

        val activity = setup()
        connect(activity, FakeServer.closedPortOrigin())
        assertTrue(errorOf(activity), errorOf(activity)!!.startsWith("Geen verbinding met de server."))
    }
}
