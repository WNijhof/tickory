package io.github.wnijhof.tickory.widget

import android.Manifest
import android.app.Application
import androidx.test.core.app.ApplicationProvider
import androidx.work.Configuration
import androidx.work.testing.SynchronousExecutor
import androidx.work.testing.WorkManagerTestInitHelper
import io.github.wnijhof.tickory.core.WidgetFixtures
import io.github.wnijhof.tickory.core.WidgetSnapshot
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import org.junit.After
import org.junit.Before
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.util.TimeZone
import java.util.concurrent.Executor
import javax.crypto.KeyGenerator

/**
 * Gemeenschappelijke voorbereiding van de tests van de widgets op een nagebootst Android: Amsterdam, vrijdag 13 november
 * 2026 om 09:00, een sleutel uit de test in plaats van de Android Keystore, en een WorkManager die niets uit zichzelf uitvoert.
 */
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
abstract class WidgetTestBase {
    protected val app: Application = ApplicationProvider.getApplicationContext()
    protected val origin = "https://taken.voorbeeld.nl"
    protected val token = "tky_test-token_0123456789-ABCDEFGHIJ"
    protected var now: Long = WidgetFixtures.at("2026-11-13T09:00")

    private val originalZone: TimeZone = TimeZone.getDefault()
    private val originalExecutor: Executor = Background.executor

    @Before
    fun baseSetUp() {
        TimeZone.setDefault(TimeZone.getTimeZone("Europe/Amsterdam"))
        AppClock.now = { now }
        Background.executor = Executor { it.run() }
        val key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
        TokenVault.keySource = { key }
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        WorkManagerTestInitHelper.initializeTestWorkManager(app, Configuration.Builder().setExecutor(SynchronousExecutor()).build())
    }

    @After
    fun baseTearDown() {
        AppClock.now = { System.currentTimeMillis() }
        Background.executor = originalExecutor
        TimeZone.setDefault(originalZone)
    }

    /** Aangemeld bij [server] (standaard het voorbeeldadres) met de gegevens van een eerste verversing. */
    protected fun signIn(server: String = origin, withData: WidgetSnapshot? = null) {
        Prefs(app).setServer(server, false)
        Session.set(app, token)
        if (withData != null) WidgetStore.accept(app, withData)
    }
}
