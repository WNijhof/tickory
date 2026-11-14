package io.github.wnijhof.tickory.sync

import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.work.Worker
import androidx.work.WorkerParameters
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.FetchResult
import io.github.wnijhof.tickory.core.LocalNetwork
import io.github.wnijhof.tickory.core.ServerAddress
import io.github.wnijhof.tickory.geo.GeoEngine
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.widget.WidgetUpdater
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.reminders.ReminderEngine

/**
 * Eén verversing: eerst wat er nog aan "Voltooien" wacht alsnog versturen (uit een melding en uit een widget), dan de
 * taken, projecten en herinneringen ophalen, de alarmen bijwerken en de widgets opnieuw tekenen. Lukt het ophalen niet,
 * dan blijft het bestaande plan en de bestaande inhoud van de widgets staan.
 */
class SyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val app = applicationContext
        val prefs = Prefs(app)
        val origin = prefs.serverOrigin
        val token = if (prefs.sessionExpired) null else TokenVault.load(app)
        if (origin == null || token == null) return Result.success() // niet (meer) aangemeld: niets te doen
        if (prefs.cleartextToInternet) return Result.success() // onversleuteld naar een server op internet: het token gaat niet over de lijn

        if (!flushCompletes(app)) return failed(app, prefs, origin)

        val client = ApiClient(origin, 10_000, 20_000, Session.userAgent)

        // Na een nieuwe aanmelding weten we nog niet van wie de gegevens op het toestel zijn. Eerst vaststellen (zodat een
        // wachtrij van een andere gebruiker nooit onder dit account wordt verstuurd), dan pas de wachtrij versturen.
        var fetched: FetchResult? = null
        if (WidgetStore.isUnverified(app)) {
            fetched = client.fetchSnapshot(token)
            if (fetched is FetchResult.Ok) apply(app, fetched)
        }
        when (WidgetSync.flush(app, client, token)) {
            WidgetSync.Outcome.NOTHING -> if (fetched is FetchResult.Ok) return Result.success() // net al opgehaald en verwerkt
            WidgetSync.Outcome.SENT -> fetched = null // er is iets veranderd op de server: opnieuw ophalen
            WidgetSync.Outcome.OFFLINE -> return failed(app, prefs, origin)
            WidgetSync.Outcome.UNAUTHORIZED -> {
                ReminderEngine.replan(app)
                return Result.success()
            }
        }

        return when (val result = fetched ?: client.fetchSnapshot(token)) {
            is FetchResult.Ok -> {
                apply(app, result)
                Result.success()
            }
            is FetchResult.Unauthorized -> {
                Session.markExpired(app)
                ReminderEngine.replan(app) // de alarmen die er staan blijven; alleen bijwerken wat vanzelf verloopt
                Result.success()
            }
            is FetchResult.Failed -> failed(app, prefs, origin)
        }
    }

    /** De verse gegevens: de alarmen worden opnieuw gepland en de widgets krijgen hun nieuwe inhoud. */
    private fun apply(app: Context, result: FetchResult.Ok) {
        ReminderEngine.onSynced(app, result.snapshot)
        try {
            GeoEngine.refresh(app) // nieuwe plaatsen of herinneringen op een plek: de locatiecontrole past zich aan
        } catch (e: RuntimeException) {
            android.util.Log.w("TickoryGeo", "locatiecontrole bijwerken mislukt: ${e.javaClass.simpleName}")
        }
        result.widget?.let { WidgetStore.accept(app, it) }
        WidgetUpdater.updateAll(app)
    }

    /**
     * Verstuurt wat nog afgevinkt moest worden.
     *
     * @return false als de server niet bereikbaar was (dan heeft ophalen ook geen zin)
     */
    private fun flushCompletes(app: Context): Boolean {
        val (pending, expired) = ReminderEngine.pendingCompletes(app)
        for (old in expired) {
            Completer.note(app, old.reminder, R.string.complete_failed)
            ReminderEngine.completeSettled(app, old.reminder.reminderId)
        }
        for (item in pending) {
            when (Completer.attempt(app, item.reminder, quick = false)) {
                Completer.Outcome.DONE, Completer.Outcome.SETTLED -> ReminderEngine.completeSettled(app, item.reminder.reminderId)
                Completer.Outcome.RETRY -> return false
            }
        }
        return true
    }

    /** Geen verbinding met de server. Het plan van de vorige keer blijft gelden; we schuiven alleen het venster op. */
    private fun failed(app: Context, prefs: Prefs, origin: String): Result {
        ReminderEngine.replan(app)
        WidgetUpdater.updateAll(app) // geen nieuwe gegevens, maar een nieuwe dag of een afgevinkte taak moet wel zichtbaar worden
        noteIfLocalServerBlocked(app, prefs, origin)
        // Het kwartierwerk komt vanzelf terug; een eenmalige verversing proberen we nog een paar keer, met oplopende pauzes.
        val periodic = inputData.getBoolean(KEY_PERIODIC, false)
        return if (!periodic && runAttemptCount < MAX_RETRIES) Result.retry() else Result.success()
    }

    /**
     * Android 17 en nieuwer: zonder de toestemming "Apparaten in de buurt" is een server op het thuisnetwerk niet te
     * bereiken. Blijkt het adres (nu) naar het thuisnetwerk te wijzen, dan onthouden we dat; de app vraagt de
     * toestemming de eerstvolgende keer dat hij open gaat.
     */
    private fun noteIfLocalServerBlocked(app: Context, prefs: Prefs, origin: String) {
        if (Build.VERSION.SDK_INT < API_LOCAL_NETWORK || prefs.serverIsLocal) return
        if (ContextCompat.checkSelfPermission(app, PERMISSION_LOCAL_NETWORK) == PackageManager.PERMISSION_GRANTED) return
        val host = (ServerAddress.parse(origin) as? ServerAddress.Result.Ok)?.host ?: return
        if (LocalNetwork.hostLooksLocal(host) || LocalNetwork.resolvesToLocal(host)) prefs.serverIsLocal = true
    }

    companion object {
        const val KEY_PERIODIC = "periodic"
        private const val MAX_RETRIES = 4

        /** Android 17. Als getal, omdat de naam van de constante per SDK-uitgave nog verschilt. */
        const val API_LOCAL_NETWORK = 37
        const val PERMISSION_LOCAL_NETWORK = "android.permission.ACCESS_LOCAL_NETWORK"
    }
}
