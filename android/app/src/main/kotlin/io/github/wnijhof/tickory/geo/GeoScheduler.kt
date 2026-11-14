package io.github.wnijhof.tickory.geo

import android.content.Context
import android.util.Log
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.PeriodicWorkRequest
import androidx.work.Worker
import androidx.work.WorkerParameters
import androidx.work.WorkManager
import io.github.wnijhof.tickory.core.GeoPolicy
import java.util.concurrent.TimeUnit

/**
 * Het zekerheidsnet: elk kwartier (het minimum van Android) kijkt WorkManager of de locatiecontrole nog wat te doen heeft.
 * Dat vangt op wat de aangevraagde updates missen: een toestel dat de aanvraag kwijt is, een merk dat apps op de
 * achtergrond afknijpt, of een toestel zonder netwerklocatie, waar GPS alleen op deze momenten wordt aangezet. Alleen
 * aanwezig zolang er een herinnering op een plek is; verder staat er niets ingepland.
 */
object GeoScheduler {
    private const val TAG = "TickoryGeo"
    private const val WORK = "tickory-geo-safety-net"

    fun ensure(context: Context) = guarded {
        // De eerste keer pas na een kwartier: wie dit inplant, kijkt zelf al (zie GeoEngine.refresh), dubbel werk kost alleen stroom.
        val request = PeriodicWorkRequest.Builder(GeoWorker::class.java, GeoPolicy.SAFETY_NET_MINUTES, TimeUnit.MINUTES)
            .setInitialDelay(GeoPolicy.SAFETY_NET_MINUTES, TimeUnit.MINUTES)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    fun cancel(context: Context) = guarded { WorkManager.getInstance(context).cancelUniqueWork(WORK) }

    private inline fun guarded(block: () -> Unit) {
        try {
            block()
        } catch (e: RuntimeException) {
            Log.w(TAG, "achtergrondwerk plannen mislukt: ${e.javaClass.simpleName}")
        }
    }
}

class GeoWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val app = applicationContext
        if (!GeoEngine.wanted(app)) {
            GeoScheduler.cancel(app)
            return Result.success()
        }
        GeoEngine.tick(app)
        return Result.success()
    }
}
