package io.github.wnijhof.tickory.widget

import android.content.Intent
import android.view.ViewGroup
import android.webkit.WebView
import androidx.work.WorkInfo
import androidx.work.WorkManager
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.WebBridge
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.store.Prefs
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/** De app en de web-app praten met de widgets: het venster Taak toevoegen openen, en laten weten dat er iets veranderd is. */
class WidgetBridgeTest : WidgetTestBase() {
    private fun main(intent: Intent? = null): MainActivity {
        Prefs(app).setServer(origin, false)
        val controller = if (intent != null) Robolectric.buildActivity(MainActivity::class.java, intent) else Robolectric.buildActivity(MainActivity::class.java)
        return controller.setup().get()
    }

    private fun webViewOf(activity: MainActivity): WebView = activity.findViewById<ViewGroup>(R.id.web_container).getChildAt(0) as WebView

    private fun addIntent(target: String?) = Intent(app, MainActivity::class.java).putExtra(DeepLink.EXTRA_ADD, target ?: "")

    @Test
    fun `de plusknop van een widget opent de app op Taak toevoegen`() {
        assertEquals("$origin/#add", shadowOf(webViewOf(main(addIntent(null)))).lastLoadedUrl)
    }

    @Test
    fun `Taak toevoegen met vandaag of in een project`() {
        assertEquals("$origin/#add=today", shadowOf(webViewOf(main(addIntent("today")))).lastLoadedUrl)
        assertEquals("$origin/#add=inbox-project", shadowOf(webViewOf(main(addIntent("inbox-project")))).lastLoadedUrl)
    }

    @Test
    fun `een raar doel wordt gewoon Taak toevoegen`() {
        for (bad in listOf("x';alert(1);'", "a b", "../x", "a#b")) {
            assertEquals("'$bad'", "$origin/#add", shadowOf(webViewOf(main(addIntent(bad)))).lastLoadedUrl)
        }
    }

    @Test
    fun `een taak gaat voor Taak toevoegen, en een gewone start heeft geen fragment`() {
        val both = addIntent("today").putExtra(Notifications.EXTRA_TASK_ID, "task-0001")
        assertEquals("$origin/#task=task-0001", shadowOf(webViewOf(main(both))).lastLoadedUrl)
        assertEquals("$origin/", shadowOf(webViewOf(main())).lastLoadedUrl)
    }

    @Test
    fun `staat de web-app al open, dan verandert de plusknop alleen het fragment`() {
        Prefs(app).setServer(origin, false)
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val webView = webViewOf(controller.get())
        shadowOf(webView).webViewClient.onPageFinished(webView, "$origin/")

        controller.newIntent(addIntent("today"))

        assertEquals("er is niet opnieuw geladen", "$origin/", shadowOf(webView).lastLoadedUrl)
        val script = shadowOf(webView).lastEvaluatedJavascript
        assertNotNull(script)
        assertTrue(script, script.contains("'#add=today'") && script.contains("location.hash=h"))
    }

    @Test
    fun `de brug - widgetsChanged ververst de gegevens, maar alleen voor een pagina van de eigen server`() {
        signIn()
        val activity = main()
        val webView = webViewOf(activity)
        val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
        val work = WorkManager.getInstance(app)

        work.cancelAllWork().result.get() // wat het inloggen zelf al inplande, telt hier niet

        // een vreemde pagina: niets
        webView.loadUrl("https://kwaad.voorbeeld.org/")
        bridge.widgetsChanged()
        assertTrue(work.getWorkInfosForUniqueWork("tickory-sync-now").get().none { it.state == WorkInfo.State.ENQUEUED })

        // de eigen server: meteen verversen en een halve minuut later nog eens
        webView.loadUrl("$origin/")
        bridge.widgetsChanged()
        assertTrue(work.getWorkInfosForUniqueWork("tickory-sync-now").get().any { it.state == WorkInfo.State.ENQUEUED })
        assertTrue(work.getWorkInfosForUniqueWork("tickory-sync-later").get().any { it.state == WorkInfo.State.ENQUEUED })
    }

    @Test
    fun `de brug - zonder aanmelding verandert widgetsChanged niets`() {
        val activity = main()
        val webView = webViewOf(activity)
        val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
        webView.loadUrl("$origin/")
        bridge.widgetsChanged()
        assertTrue(WorkManager.getInstance(app).getWorkInfosForUniqueWork("tickory-sync-now").get().isEmpty())
    }

    @Test
    fun `de brug - een nieuwe aanmelding via de web-app verbergt de gegevens van de vorige gebruiker`() {
        signIn(withData = snapshot(listOf(task("t1", "2026-11-13"))))
        val activity = main()
        val webView = webViewOf(activity)
        val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
        webView.loadUrl("$origin/")
        bridge.setSession("tky_nieuwe-gebruiker_0123456789-ABCDEF")
        assertEquals(WidgetModel.State.Loading, WidgetModel.state(app, io.github.wnijhof.tickory.core.WidgetSource.Today))
        bridge.setSession("")
        assertEquals(WidgetModel.State.SignedOut, WidgetModel.state(app, io.github.wnijhof.tickory.core.WidgetSource.Today))
    }
}
