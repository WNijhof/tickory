package io.github.wnijhof.tickory.geo

import android.Manifest
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.PositionScript
import io.github.wnijhof.tickory.reminders.Background
import io.github.wnijhof.tickory.store.GeoStore

/**
 * De toestemmingen voor locatie, met uitleg vooraf en zonder aandringen. Er wordt alleen gevraagd na een keuze van de
 * gebruiker zelf: de eerste herinnering op een plek maken, of de locatiecontrole aanzetten bij Plaatsen. Nooit bij het
 * starten van de app.
 *
 * Stappen: (1) uitleg, (2) nauwkeurige locatie, (3) uitleg en vraag om "Altijd toestaan" (ook als de app dicht is).
 * Wordt de eerste stap geweigerd, dan zet de app de locatiecontrole weer uit en onthoudt hij dat, zodat de web-app
 * "Instellingen openen" kan aanbieden in plaats van steeds dezelfde vraag. Zonder "Altijd toestaan" werkt het nog wel,
 * maar alleen terwijl de app open staat; dat is te zien bij Plaatsen.
 *
 * Moet worden aangemaakt voordat de activity start (de aanvragen worden dan geregistreerd), dus als veld van de activity.
 *
 * @param onChanged wordt op de hoofddraad aangeroepen als de toestand verandert, zodat de pagina haar status opnieuw vraagt
 * @param deliver geeft een stukje JavaScript door aan de web-app (zie [PositionScript])
 */
class GeoPermissionFlow(
    private val activity: ComponentActivity,
    private val onChanged: () -> Unit,
    private val deliver: (String) -> Unit,
) {
    private var preciseRationaleBefore = false
    private var wantPosition = false

    private val foreground = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onForegroundResult() }
    private val background = activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted -> onBackgroundResult(granted) }
    private val positionPermission = activity.registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { onPositionPermissionResult() }

    /** De gebruiker wil herinneringen op een plek: eerst uitleg, dan de toestemmingen. */
    fun start() {
        val app = activity.applicationContext
        if (GeoPermissions.precise(app) && GeoPermissions.background(app) && GeoPermissions.servicesOn(app)) {
            enable()
            return
        }
        AlertDialog.Builder(activity)
            .setTitle(R.string.geo_intro_title)
            .setMessage(R.string.geo_intro_message)
            .setPositiveButton(R.string.geo_continue) { _, _ -> afterIntro() }
            .setNegativeButton(R.string.cancel, null)
            .show()
    }

    private fun afterIntro() {
        val app = activity.applicationContext
        GeoStore.setEnabled(app, true)
        GeoStore.setDeclined(app, false)
        if (!GeoPermissions.servicesOn(app)) {
            Toast.makeText(activity, R.string.geo_services_off, Toast.LENGTH_LONG).show()
            openLocationSettings(servicesOff = true)
        }
        if (GeoPermissions.precise(app)) {
            askBackground()
        } else {
            preciseRationaleBefore = activity.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
            foreground.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
        }
    }

    private fun onForegroundResult() {
        val app = activity.applicationContext
        if (GeoPermissions.precise(app)) {
            askBackground()
            return
        }
        // Geweigerd, of alleen bij benadering: te grof voor een plaats. Terug naar uit, en onthouden dat er is geweigerd.
        GeoStore.setEnabled(app, false)
        GeoStore.setDeclined(app, true)
        Toast.makeText(activity, if (GeoPermissions.approximateOnly(app)) R.string.geo_approximate else R.string.geo_denied, Toast.LENGTH_LONG).show()
        val permanent = !preciseRationaleBefore && !activity.shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION)
        if (permanent && !GeoPermissions.approximateOnly(app)) openLocationSettings(servicesOff = false)
        changed()
    }

    private fun askBackground() {
        val app = activity.applicationContext
        if (GeoPermissions.background(app)) {
            enable()
            return
        }
        AlertDialog.Builder(activity)
            .setTitle(R.string.geo_background_title)
            .setMessage(R.string.geo_background_message)
            .setPositiveButton(R.string.geo_continue) { _, _ ->
                // Op Android 11 en nieuwer brengt Android de gebruiker hierbij naar het instellingenscherm van de app.
                background.launch(Manifest.permission.ACCESS_BACKGROUND_LOCATION)
            }
            .setNegativeButton(R.string.geo_later) { _, _ -> enable() }
            .setOnCancelListener { enable() }
            .show()
    }

    private fun onBackgroundResult(granted: Boolean) {
        if (!granted) Toast.makeText(activity, R.string.geo_background_missing, Toast.LENGTH_LONG).show()
        enable()
    }

    private fun enable() {
        val app = activity.applicationContext
        GeoStore.setEnabled(app, true)
        GeoStore.setDeclined(app, false)
        Background.executor.execute {
            GeoEngine.refresh(app)
            activity.runOnUiThread { changed() }
        }
        changed()
    }

    private fun changed() = onChanged()

    /** Opent de instellingen: de locatiediensten van het toestel, of de rechten van deze app. */
    fun openLocationSettings(servicesOff: Boolean) {
        val intent = if (servicesOff) Intent(Settings.ACTION_LOCATION_SOURCE_SETTINGS) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", activity.packageName, null))
        try {
            activity.startActivity(intent)
        } catch (_: ActivityNotFoundException) {
            try {
                activity.startActivity(Intent(Settings.ACTION_SETTINGS))
            } catch (_: ActivityNotFoundException) {
                // geen instellingenscherm op dit toestel
            }
        }
    }

    // ---------- één keer de positie, voor "Gebruik mijn huidige positie" ----------

    /** Bepaalt één keer de positie van het toestel en geeft die aan de pagina. Vraagt zo nodig de toestemming voor locatie. */
    fun requestCurrentPosition() {
        val app = activity.applicationContext
        if (GeoPermissions.precise(app) || GeoPermissions.approximateOnly(app)) {
            fetchPosition()
            return
        }
        wantPosition = true
        positionPermission.launch(arrayOf(Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION))
    }

    private fun onPositionPermissionResult() {
        val app = activity.applicationContext
        if (!wantPosition) return
        wantPosition = false
        if (GeoPermissions.precise(app) || GeoPermissions.approximateOnly(app)) fetchPosition() else deliver(PositionScript.error("denied"))
    }

    private fun fetchPosition() {
        val app = activity.applicationContext
        Background.executor.execute {
            val source = GeoEngine.sourceFactory(app)
            // Eerst een verse bepaling; lukt dat niet, dan de laatst bekende als die van de laatste minuut is.
            val fix = source.current(POSITION_TIMEOUT_MS)
                ?: source.lastKnown().filter { io.github.wnijhof.tickory.reminders.AppClock.now() - it.atMs < 60_000 }.minByOrNull { it.accuracyM ?: Float.MAX_VALUE }
            val script = if (fix == null) PositionScript.error(if (GeoPermissions.servicesOn(app)) "timeout" else "unavailable") else PositionScript.result(fix.lat, fix.lon, fix.accuracyM)
            activity.runOnUiThread { deliver(script) }
        }
    }

    companion object {
        const val POSITION_TIMEOUT_MS = 20_000L
    }
}
