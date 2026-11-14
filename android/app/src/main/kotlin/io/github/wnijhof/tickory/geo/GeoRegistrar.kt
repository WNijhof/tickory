package io.github.wnijhof.tickory.geo

import android.annotation.SuppressLint
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.location.Location
import android.location.LocationManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.content.IntentCompat
import io.github.wnijhof.tickory.core.Fix
import io.github.wnijhof.tickory.core.GeoPolicy
import io.github.wnijhof.tickory.reminders.Background

/**
 * Vraagt bij Android om af en toe een positie, afgeleverd bij [GeoReceiver] ook als de app dicht is. Zonder Google
 * Play-services: de gewone `LocationManager`.
 *
 * Wat we vragen, in volgorde van zuinigheid:
 *  - **passief**: positiebepalingen die andere apps al laten doen. Kost ons niets.
 *  - **netwerk** (wifi en mobiel netwerk): zuinig, enkele tientallen tot honderden meters nauwkeurig. Bestaat niet op
 *    elk toestel (zonder Google-diensten is er een eigen netwerklocatiedienst voor nodig).
 *  - **GPS** alleen als er geen netwerkbron is, en dan met een rustig interval. De eenmalige GPS-bepaling van het
 *    zekerheidsnet ([GeoEngine.tick]) staat hier los van.
 *
 * Elke bron krijgt een eigen [PendingIntent], want een tweede aanvraag met dezelfde vervangt de eerste.
 */
object GeoRegistrar {
    private const val TAG = "TickoryGeo"
    const val ACTION = "io.github.wnijhof.tickory.action.LOCATION"

    /** Zonder netwerkbron vragen we GPS hooguit zo vaak. */
    private const val GPS_ONLY_MIN_INTERVAL_MS = 5L * 60 * 1000

    private val SLOTS = listOf(LocationManager.PASSIVE_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.GPS_PROVIDER)

    /** @return true als minstens één bron is aangevraagd */
    @SuppressLint("MissingPermission") // SecurityException wordt hieronder opgevangen: dan is de toestemming ingetrokken
    fun register(context: Context, cadence: GeoPolicy.Cadence): Boolean {
        val app = context.applicationContext
        val lm = app.getSystemService(LocationManager::class.java) ?: return false
        var any = false
        val networkOn = enabled(lm, LocationManager.NETWORK_PROVIDER)
        for (provider in SLOTS) {
            val wanted = when (provider) {
                LocationManager.PASSIVE_PROVIDER -> true
                LocationManager.NETWORK_PROVIDER -> networkOn
                else -> !networkOn && enabled(lm, LocationManager.GPS_PROVIDER)
            }
            val pi = pendingIntent(app, provider)
            if (!wanted) {
                lm.removeUpdatesQuietly(pi)
                continue
            }
            val minTime = if (provider == LocationManager.GPS_PROVIDER) maxOf(cadence.minTimeMs, GPS_ONLY_MIN_INTERVAL_MS) else cadence.minTimeMs
            try {
                lm.requestLocationUpdates(provider, minTime, cadence.minDistanceM, pi)
                any = true
            } catch (e: SecurityException) {
                Log.w(TAG, "geen toestemming voor locatie")
                return false
            } catch (e: RuntimeException) {
                Log.w(TAG, "locatie aanvragen mislukt voor $provider: ${e.javaClass.simpleName}")
            }
        }
        return any
    }

    fun unregister(context: Context) {
        val app = context.applicationContext
        val lm = app.getSystemService(LocationManager::class.java) ?: return
        for (provider in SLOTS) lm.removeUpdatesQuietly(pendingIntent(app, provider))
    }

    private fun LocationManager.removeUpdatesQuietly(pi: PendingIntent) {
        try {
            removeUpdates(pi)
        } catch (_: RuntimeException) {
            // niets aangevraagd of geen toestemming meer: dan is er ook niets te stoppen
        }
    }

    private fun enabled(lm: LocationManager, provider: String): Boolean = try {
        lm.isProviderEnabled(provider)
    } catch (_: RuntimeException) {
        false
    }

    /**
     * Android zet de positie in de intent, dus die moet veranderbaar zijn (vanaf Android 12 verplicht aan te geven). De
     * intent is expliciet gericht aan onze eigen ontvanger, zoals voor een veranderbare intent hoort.
     */
    private fun pendingIntent(context: Context, provider: String): PendingIntent {
        val intent = Intent(context, GeoReceiver::class.java)
            .setAction(ACTION)
            .setData(Uri.Builder().scheme("tickory").authority("location").appendPath(provider).build())
        val mutable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or mutable)
    }

    /** De plaatsbepalingen in een intent van Android: één (`location`) of meerdere (`locations`, Android 12 en nieuwer). */
    fun fixesFrom(intent: Intent): List<Fix> {
        val out = ArrayList<Fix>()
        try {
            IntentCompat.getParcelableArrayListExtra(intent, "locations", Location::class.java)?.forEach { out.add(PlatformLocationSource.toFix(it)) }
            if (out.isEmpty()) IntentCompat.getParcelableExtra(intent, LocationManager.KEY_LOCATION_CHANGED, Location::class.java)?.let { out.add(PlatformLocationSource.toFix(it)) }
        } catch (e: RuntimeException) {
            Log.w(TAG, "onleesbare locatie in intent: ${e.javaClass.simpleName}")
        }
        return out
    }
}

/** Android levert plaatsbepalingen af, ook als de app dicht is. Het werk gaat op een achtergronddraad. */
class GeoReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != GeoRegistrar.ACTION) return
        val fixes = GeoRegistrar.fixesFrom(intent)
        if (fixes.isEmpty()) return
        val app = context.applicationContext
        val pending: PendingResult? = goAsync()
        Background.executor.execute {
            try {
                GeoEngine.onFixes(app, fixes)
            } catch (e: RuntimeException) {
                Log.e("TickoryGeo", "plaatsbepaling verwerken mislukt", e)
            } finally {
                pending?.finish()
            }
        }
    }
}
