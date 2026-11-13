package io.github.wnijhof.tickory.sync

import android.content.Context
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.BatchResult
import io.github.wnijhof.tickory.core.CommandStatus
import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.core.SyncCommand
import io.github.wnijhof.tickory.core.WidgetQueue
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.WidgetStore

/** Verstuurt de taken die in een widget zijn afgevinkt naar de server. */
object WidgetSync {
    enum class Outcome {
        /** Er stond niets te versturen. */
        NOTHING,

        /** Alles wat kon is afgehandeld (gelukt of definitief geweigerd); er kan nog iets zijn blijven staan dat de server niet noemde. */
        SENT,

        /** De server was niet bereikbaar, of gaf een tijdelijke fout: later opnieuw, met dezelfde uuid's. */
        OFFLINE,

        /** De aanmelding geldt niet meer. De wachtrij blijft staan voor als dezelfde gebruiker opnieuw inlogt. */
        UNAUTHORIZED,
    }

    /**
     * Verstuurt de wachtrij van de aangemelde gebruiker. Eerst vliegt weg wat te lang wacht (drie dagen). Wat de server
     * weigert (de taak is weg, je bent geen lid meer van het project, of wat dan ook) blijft niet hangen: het wordt uit de
     * wachtrij gehaald, en de verversing die erop volgt laat zien hoe de taak er echt voor staat.
     */
    fun flush(context: Context, client: ApiClient, token: String): Outcome {
        val app = context.applicationContext
        WidgetStore.updateQueue(app) { items -> WidgetQueue.settle(items, WidgetQueue.expired(items, AppClock.now()).mapTo(HashSet()) { it.uuid }) }
        if (WidgetStore.isUnverified(app)) return Outcome.NOTHING // van wie de gegevens zijn staat nog niet vast: niets versturen
        val account = WidgetStore.snapshot(app)?.accountId

        var sentAny = false
        // Meer dan een ronde voor een lange wachtrij, en voor een server die `if_due` nog niet kent (zie hieronder).
        repeat(MAX_ROUNDS) {
            val mine = WidgetQueue.forAccount(WidgetStore.queue(app), account).take(WidgetQueue.BATCH)
            if (mine.isEmpty()) return if (sentAny) Outcome.SENT else Outcome.NOTHING
            val commands = mine.map { complete(it) }
            when (val result = client.sendCommands(token, commands)) {
                BatchResult.Unauthorized -> {
                    Session.markExpired(app)
                    return Outcome.UNAUTHORIZED
                }
                BatchResult.Failed -> return Outcome.OFFLINE
                is BatchResult.Rejected -> {
                    // De server wil dit hele verzoek niet (bijvoorbeeld te groot). Opnieuw sturen verandert niets.
                    WidgetStore.updateQueue(app) { WidgetQueue.settle(it, mine.mapTo(HashSet()) { item -> item.uuid }) }
                    return Outcome.SENT
                }
                is BatchResult.Done -> {
                    val settled = HashSet<String>()
                    val unguarded = ArrayList<QueuedComplete>() // alleen `if_due` werd niet begrepen: zonder opnieuw
                    var missing = false
                    for (item in mine) {
                        when (val status = result.statuses[item.uuid] ?: CommandStatus.Missing) {
                            CommandStatus.Ok -> settled.add(item.uuid)
                            is CommandStatus.Rejected ->
                                if (status.code == "UNKNOWN_ARG" && item.ifDue != null) unguarded.add(item) else settled.add(item.uuid)
                            CommandStatus.Missing -> missing = true // de server noemde dit commando niet: laten staan en later nog eens
                        }
                    }
                    WidgetStore.updateQueue(app) { items ->
                        var next = WidgetQueue.settle(items, settled)
                        for (item in unguarded) next = WidgetQueue.withoutGuard(next, item.uuid, WidgetQueue.newUuid())
                        next
                    }
                    sentAny = true
                    if (missing) return Outcome.OFFLINE
                }
            }
        }
        return Outcome.SENT
    }

    private const val MAX_ROUNDS = 4

    private fun complete(item: QueuedComplete): SyncCommand {
        val args = LinkedHashMap<String, Any?>()
        args["id"] = item.taskId
        if (item.ifDue != null) args["if_due"] = item.ifDue
        return SyncCommand("task_complete", item.uuid, args)
    }
}
