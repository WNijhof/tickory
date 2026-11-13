package io.github.wnijhof.tickory.sync

import android.content.Context
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.PeriodicWorkRequest
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * Plant het verversen in met WorkManager: elk kwartier op de achtergrond, en eenmalig "nu" als daar aanleiding voor is.
 * Alles alleen met een netwerkverbinding. WorkManager gebruikt de taakplanner van Android zelf; er komt geen dienst
 * van Google aan te pas.
 */
object SyncScheduler {
    private const val TAG = "TickorySync"
    private const val PERIODIC = "tickory-sync-periodic"
    private const val NOW = "tickory-sync-now"
    private const val LATER = "tickory-sync-later"

    /** Kort na een wijziging nog een keer kijken, voor het geval de web-app zijn wijziging nog aan het versturen was. */
    private const val FOLLOW_UP_SECONDS = 30L

    private val connected: Constraints = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    /** Begint (of houdt in stand) het verversen per kwartier, en ververst nu. */
    fun start(context: Context) {
        guarded {
            val periodic = PeriodicWorkRequest.Builder(SyncWorker::class.java, 15, TimeUnit.MINUTES)
                .setConstraints(connected)
                .setInputData(workDataOf(SyncWorker.KEY_PERIODIC to true))
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, periodic)
        }
        refreshNow(context)
    }

    /**
     * Eenmalig verversen, zo snel als het kan. Een verzoek dat nog wachtte wordt vervangen, zodat tien seintjes
     * achter elkaar niet tien keer de server belasten.
     *
     * @param followUp plan ook een tweede verversing een halve minuut later
     */
    fun refreshNow(context: Context, followUp: Boolean = false) {
        guarded {
            val manager = WorkManager.getInstance(context)
            manager.enqueueUniqueWork(NOW, ExistingWorkPolicy.REPLACE, oneTime(0))
            if (followUp) manager.enqueueUniqueWork(LATER, ExistingWorkPolicy.REPLACE, oneTime(FOLLOW_UP_SECONDS))
        }
    }

    /** Stopt al het verversen (afmelden, sessie verlopen, andere server). */
    fun stop(context: Context) {
        guarded {
            val manager = WorkManager.getInstance(context)
            manager.cancelUniqueWork(PERIODIC)
            manager.cancelUniqueWork(NOW)
            manager.cancelUniqueWork(LATER)
        }
    }

    private fun oneTime(delaySeconds: Long): OneTimeWorkRequest =
        OneTimeWorkRequest.Builder(SyncWorker::class.java)
            .setConstraints(connected)
            .setInitialDelay(delaySeconds, TimeUnit.SECONDS)
            .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
            .build()

    /** WorkManager hoort altijd beschikbaar te zijn; mocht dat op een toestel toch misgaan, dan mag de app daar niet op vastlopen. */
    private inline fun guarded(block: () -> Unit) {
        try {
            block()
        } catch (e: RuntimeException) {
            Log.w(TAG, "achtergrondwerk plannen mislukt: ${e.javaClass.simpleName}")
        }
    }
}
