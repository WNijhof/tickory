package io.github.wnijhof.tickory

import android.content.Context
import android.os.PowerManager
import android.webkit.JavascriptInterface
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.reminders.AlarmScheduler
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler

/**
 * De brug tussen de web-app en Android: in de pagina bereikbaar als `window.TickoryAndroid`.
 *
 * Elke methode kijkt eerst of de pagina die nu geladen is bij de ingestelde server hoort. Zo niet, dan gebeurt er
 * niets. Alle parameters en uitkomsten zijn tekst. De methoden worden door de WebView op een eigen draad aangeroepen,
 * niet op de hoofddraad; wat een scherm nodig heeft, gaat via [MainActivity.runOnUiThread].
 */
class WebBridge(private val activity: MainActivity) {
    private val app: Context = activity.applicationContext

    /** Het sessietoken van de ingelogde gebruiker, of "" bij afmelden. */
    @JavascriptInterface
    fun setSession(token: String?) {
        if (!activity.isTrustedPage()) return
        Session.set(app, token ?: "")
    }

    /** Taken of herinneringen zijn gewijzigd: meteen verversen (en een halve minuut later nog eens, voor de zekerheid). */
    @JavascriptInterface
    fun remindersChanged() {
        if (!activity.isTrustedPage()) return
        if (Session.isActive(app)) SyncScheduler.refreshNow(app, followUp = true)
    }

    /** JSON: {"notifications":bool,"exactAlarms":bool,"batteryOptimized":bool,"appVersion":"…"} */
    @JavascriptInterface
    fun notificationStatus(): String {
        if (!activity.isTrustedPage()) return "{}"
        val power = app.getSystemService(PowerManager::class.java)
        return Json.stringify(
            mapOf(
                "notifications" to Notifications.enabled(app),
                "exactAlarms" to AlarmScheduler.canScheduleExact(app),
                // true = Android mag de app op de achtergrond afremmen om de batterij te sparen
                "batteryOptimized" to (power != null && !power.isIgnoringBatteryOptimizations(app.packageName)),
                "appVersion" to BuildConfig.VERSION_NAME,
            ),
        )
    }

    /** Vraagt de toestemming voor meldingen (Android 13 en nieuwer) en opent zo nodig het scherm voor exacte alarmen. */
    @JavascriptInterface
    fun requestNotificationPermission() {
        if (!activity.isTrustedPage()) return
        activity.runOnUiThread { activity.requestNotificationPermission() }
    }

    @JavascriptInterface
    fun openNotificationSettings() {
        if (!activity.isTrustedPage()) return
        activity.runOnUiThread { activity.openNotificationSettings() }
    }

    @JavascriptInterface
    fun openBatterySettings() {
        if (!activity.isTrustedPage()) return
        activity.runOnUiThread { activity.openBatterySettings() }
    }

    /** Terug naar het instelscherm, na bevestiging in een dialoog van Android. */
    @JavascriptInterface
    fun changeServer() {
        if (!activity.isTrustedPage()) return
        activity.runOnUiThread { activity.confirmChangeServer() }
    }

    companion object {
        const val NAME = "TickoryAndroid"
    }
}
