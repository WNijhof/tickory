package io.github.wnijhof.tickory.reminders

import android.content.Context
import io.github.wnijhof.tickory.core.PendingComplete
import io.github.wnijhof.tickory.core.PlanOutcome
import io.github.wnijhof.tickory.core.PlannedReminder
import io.github.wnijhof.tickory.core.ReminderLogic
import io.github.wnijhof.tickory.core.SyncSnapshot
import io.github.wnijhof.tickory.store.ReminderStore
import java.time.ZoneId

/**
 * Voert uit wat de regels (ReminderLogic) besluiten: alarmen zetten en wissen, meldingen tonen, en de toestand bewaren.
 * Alles loopt door één slot, zodat een alarm, een verversing en een tik op een knop elkaar niet in de weg zitten.
 */
object ReminderEngine {
    private val lock = Any()

    /**
     * Kijkt opnieuw wat er moet gebeuren, op basis van wat bewaard is. Veilig om vaak aan te roepen: toont wat nu aan
     * de beurt is (één keer) en zet alle alarmen opnieuw. Aangeroepen als een alarm afgaat, na het opstarten van het
     * toestel, bij een andere tijdzone of klok, als de app naar voren komt en na elke verversing.
     */
    fun replan(context: Context) {
        val app = context.applicationContext
        synchronized(lock) {
            apply(app, ReminderLogic.replan(ReminderStore.load(app), AppClock.now(), ZoneId.systemDefault()))
        }
    }

    /** Nieuwe gegevens van de server. Meldingen en uitstel van taken die intussen klaar of weg zijn, verdwijnen. */
    fun onSynced(context: Context, snapshot: SyncSnapshot) {
        val app = context.applicationContext
        synchronized(lock) {
            val (state, droppedSnoozes) = ReminderLogic.onSynced(ReminderStore.load(app), snapshot)
            for (id in droppedSnoozes) AlarmScheduler.cancel(app, AlarmScheduler.Kind.SNOOZE, id)
            val active = snapshot.activeTaskIds()
            // een melding die wacht op "Voltooien" (geen verbinding) laten we staan tot dat is afgehandeld
            val waiting = state.pendingCompletes.values.mapTo(HashSet()) { it.reminder.taskId }
            Notifications.cancelWhere(app) { taskId -> taskId in active || taskId in waiting }
            apply(app, ReminderLogic.replan(state, AppClock.now(), ZoneId.systemDefault()))
        }
    }

    /** "Over 10 minuten": de melding verdwijnt en komt over tien minuten terug. */
    fun snooze(context: Context, reminder: PlannedReminder) {
        val app = context.applicationContext
        synchronized(lock) {
            val (state, snoozed) = ReminderLogic.snooze(ReminderStore.load(app), reminder, AppClock.now())
            ReminderStore.save(app, state)
            AlarmScheduler.set(app, AlarmScheduler.Kind.SNOOZE, snoozed.reminderId, snoozed.fireAtMs)
            Notifications.cancel(app, reminder.reminderId)
        }
    }

    /** "Voltooien" kon de server niet bereiken: onthouden, zodat de volgende verversing het opnieuw probeert. */
    fun queueComplete(context: Context, reminder: PlannedReminder) {
        val app = context.applicationContext
        synchronized(lock) {
            ReminderStore.save(app, ReminderLogic.queueComplete(ReminderStore.load(app), reminder, AppClock.now()))
        }
    }

    /** Wat nog bij de server afgevinkt moet worden, en wat daarvan te lang wacht om nog te proberen. */
    fun pendingCompletes(context: Context): Pair<List<PendingComplete>, List<PendingComplete>> {
        val app = context.applicationContext
        synchronized(lock) {
            val state = ReminderStore.load(app)
            val expired = ReminderLogic.expiredCompletes(state, AppClock.now())
            return state.pendingCompletes.values.filter { it !in expired } to expired
        }
    }

    /** Het voltooien is afgehandeld (gelukt, geweigerd of opgegeven): niet meer proberen. */
    fun completeSettled(context: Context, reminderId: String) {
        val app = context.applicationContext
        synchronized(lock) {
            ReminderStore.save(app, ReminderLogic.completeSettled(ReminderStore.load(app), reminderId))
        }
    }

    /** De taak is afgevinkt: alle meldingen en uitstel voor die taak weg. */
    fun onTaskCompleted(context: Context, taskId: String) {
        val app = context.applicationContext
        synchronized(lock) {
            val (state, droppedSnoozes) = ReminderLogic.onTaskCompleted(ReminderStore.load(app), taskId)
            for (id in droppedSnoozes) AlarmScheduler.cancel(app, AlarmScheduler.Kind.SNOOZE, id)
            ReminderStore.save(app, state)
            Notifications.cancelWhere(app) { it != taskId }
        }
    }

    /**
     * Afmelden, een andere gebruiker of een andere server: alle alarmen en meldingen weg.
     *
     * @param keepShown onthoud wat al getoond is (dezelfde gebruiker meldt zich opnieuw aan), zodat niets twee keer afgaat
     */
    fun clear(context: Context, keepShown: Boolean) {
        val app = context.applicationContext
        synchronized(lock) {
            val state = ReminderStore.load(app)
            for (id in state.scheduled.keys) AlarmScheduler.cancel(app, AlarmScheduler.Kind.REMINDER, id)
            for (id in state.snoozed.keys) AlarmScheduler.cancel(app, AlarmScheduler.Kind.SNOOZE, id)
            ReminderStore.save(app, ReminderLogic.cleared(state, keepShown))
            Notifications.cancelAll(app)
        }
    }

    private fun apply(app: Context, outcome: PlanOutcome) {
        for (id in outcome.cancel) AlarmScheduler.cancel(app, AlarmScheduler.Kind.REMINDER, id)
        for (id in outcome.snoozeCancel) AlarmScheduler.cancel(app, AlarmScheduler.Kind.SNOOZE, id)
        // Altijd opnieuw zetten, ook als er niets veranderd lijkt: na een herstart of geforceerd stoppen zijn de alarmen
        // bij Android weg terwijl onze opslag ze nog kent. Hetzelfde alarm nog eens zetten vervangt het oude.
        for (planned in outcome.schedule) AlarmScheduler.set(app, AlarmScheduler.Kind.REMINDER, planned.reminderId, planned.triggerAtMs)
        for (snoozed in outcome.snoozeSchedule) AlarmScheduler.set(app, AlarmScheduler.Kind.SNOOZE, snoozed.reminderId, snoozed.fireAtMs)

        // Eerst tonen, dan pas vastleggen dat het getoond is. Valt het proces daartussen weg, dan komt de melding hooguit
        // nog een keer (op dezelfde plek, want hetzelfde label); andersom zou de herinnering voorgoed verloren zijn.
        for (planned in outcome.fireNow) Notifications.show(app, planned)
        for (snoozed in outcome.snoozeFireNow) Notifications.show(app, snoozed.asPlanned())
        ReminderStore.save(app, outcome.state)
    }
}
