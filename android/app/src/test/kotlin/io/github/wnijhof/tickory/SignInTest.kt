package io.github.wnijhof.tickory

import android.app.Application
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.core.SignInLink
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import org.junit.After
import org.junit.Assert.assertEquals
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
 * Inloggen via SSO op een nagebootst Android (Robolectric): de terugkeerlink tickory://oidc komt bij de app aan (intent-filter), laadt
 * de web-app met het fragment, en de brug opent alleen het startadres op de eigen server in de browser (een Custom Tab). Of een echte
 * browser na het inloggen terugspringt naar de app, is alleen op een toestel te controleren (zie android/README.md).
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class SignInTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val origin = "https://taken.voorbeeld.nl"
    private val code = "tko_" + "b".repeat(43)
    private val start = "$origin/api/v1/auth/oidc/authorize?state=" + "s".repeat(43)
    private val originalExecutor: Executor = Background.executor

    @Before
    fun setUp() {
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
        Prefs(app).setServer(origin, false)
    }

    @After
    fun tearDown() {
        Background.executor = originalExecutor
    }

    private fun webViewOf(activity: MainActivity): WebView = activity.findViewById<ViewGroup>(R.id.web_container).getChildAt(0) as WebView
    private fun returnIntent(link: String) = Intent(Intent.ACTION_VIEW, Uri.parse(link)).addCategory(Intent.CATEGORY_BROWSABLE)

    @Test
    fun `de terugkeerlink tickory-oidc opent de app, andere links op dit schema niet`() {
        val pm = app.packageManager
        val found = pm.queryIntentActivities(returnIntent("tickory://oidc?code=$code").setPackage(app.packageName), PackageManager.MATCH_DEFAULT_ONLY)
        assertEquals(MainActivity::class.java.name, found.single().activityInfo.name)
        for (other in listOf("tickory://task/abc", "tickory://notification/abc", "https://taken.voorbeeld.nl/")) {
            assertTrue(other, pm.queryIntentActivities(returnIntent(other).setPackage(app.packageName), PackageManager.MATCH_DEFAULT_ONLY).isEmpty())
        }
    }

    @Test
    fun `een terugkeer start de web-app met de code of de fout achter de hekje`() {
        val activity = Robolectric.buildActivity(MainActivity::class.java, returnIntent("tickory://oidc?code=$code")).setup().get()
        assertEquals("$origin/#oidc=$code", shadowOf(webViewOf(activity)).lastLoadedUrl)
        val failed = Robolectric.buildActivity(MainActivity::class.java, returnIntent("tickory://oidc?error=NOT_ALLOWED")).setup().get()
        assertEquals("$origin/#oidc-error=NOT_ALLOWED", shadowOf(webViewOf(failed)).lastLoadedUrl)
        val bad = Robolectric.buildActivity(MainActivity::class.java, returnIntent("tickory://oidc?code=';alert(1);'")).setup().get()
        assertEquals("een kapotte link opent gewoon de app", "$origin/", shadowOf(webViewOf(bad)).lastLoadedUrl)
    }

    @Test
    fun `staat de app al open, dan laadt een terugkeer de web-app opnieuw (niet alleen het fragment)`() {
        val controller = Robolectric.buildActivity(MainActivity::class.java).setup()
        val webView = webViewOf(controller.get())
        shadowOf(webView).webViewClient.onPageFinished(webView, "$origin/")
        controller.newIntent(returnIntent("tickory://oidc?code=$code"))
        assertEquals("$origin/#oidc=$code", shadowOf(webView).lastLoadedUrl)
    }

    @Test
    fun `de brug opent alleen het startadres op de eigen server, in de browser met een Custom Tab`() {
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val webView = webViewOf(activity)
        shadowOf(webView).webViewClient.onPageFinished(webView, "$origin/")
        val bridge = shadowOf(webView).getJavascriptInterface("TickoryAndroid") as WebBridge
        for (bad in listOf("https://auth.voorbeeld.nl/authorize?state=x", "$origin/api/v1/sync", "$origin/api/v1/auth/oidc/authorize", "intent://x#Intent;end", null)) {
            bridge.openSignIn(bad)
            assertNull(bad.toString(), shadowOf(activity).nextStartedActivity)
        }
        bridge.openSignIn(start)
        val intent = shadowOf(activity).nextStartedActivity
        assertNotNull(intent)
        assertEquals(Intent.ACTION_VIEW, intent.action)
        assertEquals(start, intent.dataString)
        assertTrue(intent.hasCategory(Intent.CATEGORY_BROWSABLE))
        assertTrue("als Custom Tab", intent.extras!!.containsKey(SignInLink.EXTRA_CUSTOM_TABS_SESSION))
        assertNull("niet de app zelf", intent.component)
        // een vreemde pagina in de WebView kan de brug niet gebruiken
        webView.loadUrl("https://kwaad.voorbeeld.org/")
        bridge.openSignIn(start)
        assertNull(shadowOf(activity).nextStartedActivity)
    }
}
