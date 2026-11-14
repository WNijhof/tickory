package io.github.wnijhof.tickory.geo

import android.annotation.SuppressLint
import android.content.Context
import android.location.Location
import android.location.LocationManager
import android.os.CancellationSignal
import androidx.core.location.LocationManagerCompat
import androidx.core.util.Consumer
import io.github.wnijhof.tickory.core.Fix
import io.github.wnijhof.tickory.reminders.AppClock
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/** Waar de plaatsbepalingen vandaan komen. In tests te vervangen; op het toestel de gewone locatiedienst van Android. */
interface LocationSource {
    /** Wat Android als laatste weet, van alle bronnen. Kost geen stroom. */
    fun lastKnown(): List<Fix>

    /** Eén verse plaatsbepaling. Wacht hooguit [timeoutMs]; gebruik dit nooit op de hoofddraad. Null als het niet lukte. */
    fun current(timeoutMs: Long): Fix?
}

/**
 * De locatiedienst van Android zelf (`LocationManager`), zonder Google Play-services. Alle aanroepen vangen een ontbrekende
 * toestemming of een ontbrekende bron op: dan is het antwoord "niets", geen fout.
 */
class PlatformLocationSource(context: Context) : LocationSource {
    private val manager: LocationManager? = context.applicationContext.getSystemService(LocationManager::class.java)

    @SuppressLint("MissingPermission") // de aanroepen hieronder vangen SecurityException op
    override fun lastKnown(): List<Fix> {
        val lm = manager ?: return emptyList()
        val out = ArrayList<Fix>()
        for (provider in listOf(LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER)) {
            try {
                lm.getLastKnownLocation(provider)?.let { out.add(toFix(it)) }
            } catch (_: SecurityException) {
                // toestemming ingetrokken
            } catch (_: IllegalArgumentException) {
                // deze bron bestaat niet op dit toestel
            }
        }
        return out
    }

    override fun current(timeoutMs: Long): Fix? {
        val lm = manager ?: return null
        val network = LocationManager.NETWORK_PROVIDER.takeIf { enabled(lm, it) }
        val gps = LocationManager.GPS_PROVIDER.takeIf { enabled(lm, it) }
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        // Eerst het netwerk (snel en zuinig, maar grof), dan GPS (traag en nauwkeurig) met de tijd die over is.
        if (network != null) {
            val share = if (gps != null) timeoutMs / 3 else timeoutMs
            single(lm, network, share)?.let { return it }
        }
        if (gps != null) {
            val left = TimeUnit.NANOSECONDS.toMillis(deadline - System.nanoTime())
            if (left > 500) return single(lm, gps, left)
        }
        return null
    }

    private fun enabled(lm: LocationManager, provider: String): Boolean = try {
        lm.isProviderEnabled(provider)
    } catch (_: RuntimeException) {
        false
    }

    @SuppressLint("MissingPermission")
    private fun single(lm: LocationManager, provider: String, timeoutMs: Long): Fix? {
        val latch = CountDownLatch(1)
        var result: Location? = null
        val cancel = CancellationSignal()
        try {
            LocationManagerCompat.getCurrentLocation(lm, provider, cancel, { it.run() }, Consumer<Location?> { location ->
                result = location
                latch.countDown()
            })
            if (!latch.await(timeoutMs, TimeUnit.MILLISECONDS)) cancel.cancel()
        } catch (_: SecurityException) {
            return null
        } catch (_: IllegalArgumentException) {
            return null
        } catch (_: InterruptedException) {
            cancel.cancel()
            Thread.currentThread().interrupt()
            return null
        }
        return result?.let { toFix(it) }
    }

    companion object {
        /** Een [Location] van Android als [Fix]. Zonder tijd nemen we "nu", zonder nauwkeurigheid null. */
        fun toFix(location: Location): Fix = Fix(
            lat = location.latitude,
            lon = location.longitude,
            accuracyM = if (location.hasAccuracy()) location.accuracy else null,
            atMs = if (location.time > 0) location.time else AppClock.now(),
        )
    }
}
