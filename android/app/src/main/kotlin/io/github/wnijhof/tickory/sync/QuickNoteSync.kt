package io.github.wnijhof.tickory.sync

import android.content.Context
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.BatchResult
import io.github.wnijhof.tickory.core.CommandStatus
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.core.QuickNoteQueue
import io.github.wnijhof.tickory.core.SyncCommand
import io.github.wnijhof.tickory.quickadd.QuickAddNotifier
import io.github.wnijhof.tickory.quicknote.QuickNoteNotifier
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.QuickNoteStore
import io.github.wnijhof.tickory.store.WidgetStore

/**
 * Verstuurt de notities uit het kleine venster "Notitie toevoegen" naar de server, als commando `note_add` in de gewone
 * synchronisatie (de server voert elk uuid één keer uit). Niets gaat stil verloren: wat de server weigert, wat te lang wacht en wat
 * niet van deze gebruiker blijkt te zijn, komt als melding met de tekst terug (QuickNoteNotifier) en gaat dan uit de wachtrij.
 */
object QuickNoteSync {
    enum class Outcome {
        /** Er stond niets te versturen (of nog niets dat onder deze aanmelding mag). */
        NOTHING,

        /** Er is iets afgehandeld (aangemaakt of definitief geweigerd). */
        SENT,

        /** De server was niet bereikbaar of had een tijdelijke fout: later opnieuw, met dezelfde uuid's. */
        OFFLINE,

        /** De aanmelding geldt niet meer. De wachtrij blijft staan voor als dezelfde gebruiker opnieuw inlogt. */
        UNAUTHORIZED,
    }

    private const val MAX_ROUNDS = 4

    fun flush(context: Context, client: ApiClient, token: String): Outcome {
        val app = context.applicationContext
        val expired = QuickNoteQueue.expired(QuickNoteStore.queue(app), AppClock.now())
        QuickNoteStore.settle(app, expired)
        for (item in expired) QuickNoteNotifier.notDelivered(app, item, QuickAddNotifier.Reason.EXPIRED)

        if (WidgetStore.isUnverified(app)) return Outcome.NOTHING // van wie de gegevens zijn staat nog niet vast: niets versturen
        val account = WidgetStore.snapshot(app)?.accountId
        val session = QuickAddQueue.sessionTag(token)

        // Van een andere gebruiker (of een vorige aanmelding): nooit onder deze aanmelding versturen, en zeggen dat het niet is aangekomen.
        val foreign = QuickNoteQueue.foreign(QuickNoteStore.queue(app), account, session)
        QuickNoteStore.settle(app, foreign)
        for (item in foreign) QuickNoteNotifier.notDelivered(app, item, QuickAddNotifier.Reason.OTHER_ACCOUNT)

        var sent = expired.isNotEmpty() || foreign.isNotEmpty()
        repeat(MAX_ROUNDS) {
            val mine = QuickNoteQueue.sendable(QuickNoteStore.queue(app), account, session).take(QuickNoteQueue.BATCH)
            if (mine.isEmpty()) return if (sent) Outcome.SENT else Outcome.NOTHING
            val commands = mine.map { SyncCommand("note_add", it.uuid, QuickNoteQueue.args(it)) }
            when (val result = client.sendCommands(token, commands)) {
                BatchResult.Unauthorized -> {
                    Session.markExpired(app)
                    return Outcome.UNAUTHORIZED
                }
                BatchResult.Failed -> return Outcome.OFFLINE
                is BatchResult.Rejected -> {
                    // De server wil dit hele verzoek niet (bijvoorbeeld te groot of een oudere server): opnieuw sturen verandert niets.
                    QuickNoteStore.settle(app, mine)
                    for (item in mine) QuickNoteNotifier.notDelivered(app, item, QuickAddNotifier.reasonFor(result.code), result.code)
                    return Outcome.SENT
                }
                is BatchResult.Done -> {
                    var missing = false
                    for (item in mine) {
                        when (val status = result.statuses[item.uuid] ?: CommandStatus.Missing) {
                            CommandStatus.Ok -> QuickNoteStore.settle(app, listOf(item))
                            is CommandStatus.Rejected -> {
                                QuickNoteStore.settle(app, listOf(item))
                                QuickNoteNotifier.notDelivered(app, item, QuickAddNotifier.reasonFor(status.code), status.code)
                            }
                            CommandStatus.Missing -> missing = true // de server noemde dit commando niet: laten staan en later nog eens
                        }
                    }
                    sent = true
                    if (missing) return Outcome.OFFLINE
                }
            }
        }
        return Outcome.SENT
    }
}
