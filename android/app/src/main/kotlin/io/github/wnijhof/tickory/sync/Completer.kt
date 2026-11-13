package io.github.wnijhof.tickory.sync

import android.content.Context
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.CompleteResult
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.PlannedReminder
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.TokenVault
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.reminders.ReminderEngine

/**
 * "Voltooien" vanuit een melding: de taak afvinken bij de server en de melding bijwerken naar de uitkomst.
 * Gebruikt door de knop zelf (snelle poging) en door de verversing op de achtergrond (opnieuw proberen).
 */
object Completer {
    enum class Outcome {
        /** Afgevinkt; de melding is weg. */
        DONE,

        /** De server weigert, of de gebruiker is afgemeld; de melding legt uit waarom. Opnieuw proberen heeft geen zin. */
        SETTLED,

        /** De server was niet bereikbaar: later opnieuw proberen, met hetzelfde uuid. */
        RETRY,
    }

    /**
     * @param quick korte time-outs: voor de poging direct na de tik, die binnen de tijd moet blijven die Android een
     *   ontvanger op de achtergrond geeft
     */
    fun attempt(context: Context, reminder: PlannedReminder, quick: Boolean): Outcome {
        val app = context.applicationContext
        val prefs = Prefs(app)
        val origin = prefs.serverOrigin
        val token = if (prefs.sessionExpired) null else TokenVault.load(app)
        if (origin == null || token == null || prefs.cleartextToInternet) {
            note(app, reminder, R.string.complete_signed_out)
            return Outcome.SETTLED
        }

        val client = if (quick) ApiClient(origin, 4_000, 5_000, Session.userAgent) else ApiClient(origin, 10_000, 20_000, Session.userAgent)
        val uuid = Ids.completeUuid(reminder.reminderId, reminder.taskId, reminder.triggerAtMs)
        return when (val result = client.completeTask(token, reminder.taskId, uuid)) {
            is CompleteResult.Done -> {
                ReminderEngine.onTaskCompleted(app, reminder.taskId)
                Outcome.DONE
            }
            is CompleteResult.Rejected -> {
                // De server maakt geen onderscheid tussen "bestaat niet" en "geen toegang": beide zijn NOT_FOUND.
                val gone = result.code == "NOT_FOUND" || result.code == "FORBIDDEN"
                note(app, reminder, if (gone) R.string.complete_rejected_gone else R.string.complete_rejected_other)
                Outcome.SETTLED
            }
            is CompleteResult.Unauthorized -> {
                Session.markExpired(app)
                note(app, reminder, R.string.complete_signed_out)
                Outcome.SETTLED
            }
            is CompleteResult.Failed -> Outcome.RETRY
        }
    }

    /** Laat de melding staan met een korte uitleg, zonder de knop "Voltooien" en zonder opnieuw geluid te maken. */
    fun note(context: Context, reminder: PlannedReminder, message: Int, actions: Notifications.Actions = Notifications.Actions.SNOOZE_ONLY) {
        Notifications.show(context, reminder, note = context.getString(message), actions = actions, quiet = true)
    }
}
