package io.github.wnijhof.tickory.sync

import android.content.Context
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.core.QuickAddResult
import io.github.wnijhof.tickory.quickadd.QuickAddNotifier
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.QuickAddStore
import io.github.wnijhof.tickory.store.WidgetStore

/**
 * Verstuurt de taken uit het kleine venster "Taak toevoegen" naar de server (`POST /api/v1/quick-add`, één verzoek per taak).
 * Niets gaat stil verloren: wat de server weigert, wat te lang wacht en wat niet van deze gebruiker blijkt te zijn, komt als
 * melding met de tekst terug (QuickAddNotifier), en gaat dan uit de wachtrij.
 */
object QuickAddSync {
    enum class Outcome {
        /** Er stond niets te versturen (of nog niets dat onder deze aanmelding mag). */
        NOTHING,

        /** Er is iets afgehandeld (aangemaakt of definitief geweigerd); er kan meer staan dan in één ronde past. */
        SENT,

        /** De server was niet bereikbaar, had een tijdelijke fout of wilde even niet meer: later opnieuw, met dezelfde uuid's. */
        OFFLINE,

        /** De aanmelding geldt niet meer. De wachtrij blijft staan voor als dezelfde gebruiker opnieuw inlogt. */
        UNAUTHORIZED,
    }

    fun flush(context: Context, client: ApiClient, token: String): Outcome {
        val app = context.applicationContext
        val expired = QuickAddQueue.expired(QuickAddStore.queue(app), AppClock.now())
        QuickAddStore.settle(app, expired)
        for (item in expired) QuickAddNotifier.notDelivered(app, item, QuickAddNotifier.Reason.EXPIRED)

        if (WidgetStore.isUnverified(app)) return Outcome.NOTHING // van wie de gegevens zijn staat nog niet vast: niets versturen
        val account = WidgetStore.snapshot(app)?.accountId
        val session = QuickAddQueue.sessionTag(token)

        // Van een andere gebruiker (of een vorige aanmelding, als de gebruiker bij het intypen nog niet bekend was): nooit onder deze
        // aanmelding versturen, en zeggen dat hij niet is aangekomen.
        val foreign = QuickAddQueue.foreign(QuickAddStore.queue(app), account, session)
        QuickAddStore.settle(app, foreign)
        for (item in foreign) QuickAddNotifier.notDelivered(app, item, QuickAddNotifier.Reason.OTHER_ACCOUNT)

        val mine = QuickAddQueue.sendable(QuickAddStore.queue(app), account, session).take(QuickAddQueue.PER_RUN)
        var sent = expired.isNotEmpty() || foreign.isNotEmpty()
        for (item in mine) {
            when (val result = client.quickAdd(token, QuickAddQueue.requestBody(item, app.getString(R.string.language_code)))) {
                is QuickAddResult.Ok -> QuickAddStore.settle(app, listOf(item))
                is QuickAddResult.Rejected -> {
                    QuickAddStore.settle(app, listOf(item))
                    QuickAddNotifier.notDelivered(app, item, QuickAddNotifier.reasonFor(result.code), result.code)
                }
                QuickAddResult.Unsupported -> {
                    QuickAddStore.settle(app, listOf(item))
                    QuickAddNotifier.notDelivered(app, item, QuickAddNotifier.Reason.UNSUPPORTED)
                }
                QuickAddResult.Unauthorized -> {
                    Session.markExpired(app)
                    return Outcome.UNAUTHORIZED
                }
                is QuickAddResult.Failed -> return Outcome.OFFLINE
            }
            sent = true
        }
        return if (sent) Outcome.SENT else Outcome.NOTHING
    }
}
