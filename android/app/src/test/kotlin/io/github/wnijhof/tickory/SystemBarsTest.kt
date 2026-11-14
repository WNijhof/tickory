package io.github.wnijhof.tickory

import android.app.Application
import android.view.View
import android.view.ViewGroup
import androidx.core.graphics.Insets
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import java.util.concurrent.Executor
import javax.crypto.KeyGenerator

/**
 * De systeembalken en het toetsenbord rond de WebView. De web-app zet op een telefoon een menubalk onderaan (client/ui/bottomNav.js)
 * en rekent onder die balk met de veilige rand van het toestel (`env(safe-area-inset-bottom)`). In de app geeft MainActivity de
 * WebView zelf al ruimte voor de gebarenbalk, de statusbalk en het toetsenbord, en verbruikt de randen: de WebView ziet ze dan niet,
 * de veilige rand is 0 en er komt niets dubbel. Deze test legt dat vast; of het er op een echt toestel goed uitziet, valt hier buiten.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class SystemBarsTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
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

    private fun insets(top: Int, bottom: Int, keyboard: Int = 0): WindowInsetsCompat =
        WindowInsetsCompat.Builder()
            .setInsets(WindowInsetsCompat.Type.statusBars(), Insets.of(0, top, 0, 0))
            .setInsets(WindowInsetsCompat.Type.navigationBars(), Insets.of(0, 0, 0, bottom))
            .setInsets(WindowInsetsCompat.Type.ime(), Insets.of(0, 0, 0, keyboard))
            .build()

    @Test
    fun `de WebView krijgt ruimte voor gebarenbalk en statusbalk, en ziet de randen zelf niet (niets dubbel onder de menubalk)`() {
        Prefs(app).setServer("https://taken.voorbeeld.nl", false)
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val root = activity.findViewById<View>(R.id.root)
        val web = activity.findViewById<ViewGroup>(R.id.web_container)

        val result = ViewCompat.dispatchApplyWindowInsets(root, insets(top = 63, bottom = 48))
        assertEquals("ruimte boven voor de statusbalk", 63, root.paddingTop)
        assertEquals("ruimte onder voor de gebarenbalk", 48, root.paddingBottom)
        assertTrue("de randen zijn verbruikt: de WebView krijgt ze niet nog eens", result.isConsumed)
        assertEquals("de WebView zelf heeft geen eigen ruimte", 0, web.paddingBottom)
    }

    @Test
    fun `met het toetsenbord open wordt de WebView lager (de web-app verbergt dan de menubalk), daarna weer hoog`() {
        Prefs(app).setServer("https://taken.voorbeeld.nl", false)
        val activity = Robolectric.buildActivity(MainActivity::class.java).setup().get()
        val root = activity.findViewById<View>(R.id.root)

        ViewCompat.dispatchApplyWindowInsets(root, insets(top = 63, bottom = 48, keyboard = 820))
        assertEquals("het toetsenbord neemt de plaats van de gebarenbalk in", 820, root.paddingBottom)
        ViewCompat.dispatchApplyWindowInsets(root, insets(top = 63, bottom = 48))
        assertEquals(48, root.paddingBottom)
    }
}
