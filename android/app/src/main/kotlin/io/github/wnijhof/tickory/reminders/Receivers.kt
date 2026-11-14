package io.github.wnijhof.tickory.reminders

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ReminderLogic
import io.github.wnijhof.tickory.sync.Completer
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler
import io.github.wnijhof.tickory.widget.WidgetUpdater
import java.util.concurrent.Executor
import java.util.concurrent.Executors

/** Achtergronddraden voor werk dat niet op de hoofddraad mag (netwerk, opslag). In tests te vervangen door "meteen uitvoeren". */
object Background {
    @Volatile
    var executor: Executor = Executors.newCachedThreadPool()
}

/**
 * Een alarm van Android gaat af. Het alarm zelf zegt alleen "kijk nu": wat er getoond wordt, haalt de app uit zijn
 * eigen opslag. Daarna staan de overige alarmen weer goed, ook zonder internet.
 */
class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != AlarmScheduler.ACTION_ALARM) return
        try {
            ReminderEngine.replan(context)
        } catch (e: RuntimeException) {
            Log.e("TickoryAlarm", "herinnering tonen mislukt", e)
        }
    }
}

/** De knoppen van een melding: "Voltooien", "Over 10 minuten" en "Over 1 uur". */
class ActionReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val reminder = Notifications.reminderFrom(intent) ?: return
        val app = context.applicationContext
        when (intent.action) {
            Notifications.ACTION_SNOOZE -> ReminderEngine.snooze(app, reminder)
            Notifications.ACTION_SNOOZE_HOUR -> ReminderEngine.snooze(app, reminder, ReminderLogic.SNOOZE_LONG_MS)
            Notifications.ACTION_COMPLETE -> {
                // Meteen laten zien dat de tik is aangekomen, en de knop weghalen zodat er niet twee keer getikt wordt.
                Completer.note(app, reminder, R.string.complete_working, Notifications.Actions.NONE)
                // Eerst vastleggen dat deze taak afgevinkt moet worden, dan pas proberen. Stopt Android de app
                // halverwege, dan maakt de eerstvolgende verversing het af, met hetzelfde uuid.
                ReminderEngine.queueComplete(app, reminder)
                val pending: PendingResult? = goAsync()
                Background.executor.execute {
                    try {
                        if (Completer.attempt(app, reminder, quick = true) == Completer.Outcome.RETRY) {
                            // Geen verbinding: het blijft in de wachtrij; WorkManager probeert het opnieuw zodra er netwerk is.
                            Completer.note(app, reminder, R.string.complete_queued)
                        } else {
                            ReminderEngine.completeSettled(app, reminder.reminderId)
                        }
                        // Gelukt of niet: de gegevens bijwerken (een terugkerende taak heeft nu een nieuwe datum).
                        if (Session.isActive(app)) SyncScheduler.refreshNow(app)
                    } catch (e: RuntimeException) {
                        Log.e("TickoryAction", "voltooien mislukt", e)
                    } finally {
                        pending?.finish()
                    }
                }
            }
        }
    }
}

/**
 * Momenten waarop Android de alarmen kwijt is of de tijden anders uitvallen: na het opstarten van het toestel, na een
 * update van de app, bij een andere tijdzone of een verzette klok, en als de toestemming voor exacte alarmen verandert.
 * Het plan staat in de opslag van de app, dus dit werkt ook zonder internet.
 */
class SystemEventsReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val action = intent.action ?: return
        if (action !in HANDLED) return
        val app = context.applicationContext
        try {
            Notifications.ensureChannel(app) // de naam van het kanaal volgt de taal van het toestel
            ReminderEngine.replan(app)
            WidgetUpdater.updateAll(app) // nieuwe dag, andere tijdzone of taal: de widgets opnieuw tekenen (en het middernachtalarm opnieuw zetten)
            if (Session.isActive(app) && (action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED)) {
                SyncScheduler.start(app)
            }
        } catch (e: RuntimeException) {
            Log.e("TickorySystem", "opnieuw plannen na $action mislukt", e)
        }
    }

    private companion object {
        val HANDLED = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIMEZONE_CHANGED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_LOCALE_CHANGED,
            // AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED (Android 12 en nieuwer)
            "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED",
        )
    }
}
