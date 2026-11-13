package io.github.wnijhof.tickory.core

import java.time.ZoneId

/** Een melding die de gebruiker heeft uitgesteld ("Over 10 minuten"). */
data class SnoozedReminder(
    val reminderId: String,
    val taskId: String,
    val title: String,
    val taskDue: String?,
    /** Het tijdstip waarop de herinnering oorspronkelijk afging; hoort bij de sleutel en bij het uuid van "Voltooien". */
    val originalAtMs: Long,
    val fireAtMs: Long,
) {
    fun asPlanned(): PlannedReminder = PlannedReminder(reminderId, taskId, title, originalAtMs, taskDue)
}

/** "Voltooien" is getikt, maar de server was niet bereikbaar: bij de volgende verversing opnieuw proberen. */
data class PendingComplete(val reminder: PlannedReminder, val queuedAtMs: Long)

/**
 * Alles wat de app over herinneringen onthoudt. Onveranderlijk: elke stap maakt een nieuwe toestand.
 *
 * @property snapshot de taken en herinneringen van de laatste geslaagde verversing (alleen wat nodig is om te plannen)
 * @property scheduled waarvoor nu een alarm klaarstaat, per herinnering-id
 * @property snoozed uitgestelde meldingen, per herinnering-id
 * @property shown wat al getoond is: sleutel ([PlannedReminder.key]) -> het tijdstip waarop het moest afgaan
 * @property pendingCompletes taken die nog bij de server afgevinkt moeten worden, per herinnering-id
 */
data class ReminderState(
    val snapshot: SyncSnapshot = SyncSnapshot.EMPTY,
    val scheduled: Map<String, PlannedReminder> = emptyMap(),
    val snoozed: Map<String, SnoozedReminder> = emptyMap(),
    val shown: Map<String, Long> = emptyMap(),
    val pendingCompletes: Map<String, PendingComplete> = emptyMap(),
)

/** Wat er na een planronde moet gebeuren. De Android-kant voert dit uit (alarmen zetten, meldingen tonen). */
data class PlanOutcome(
    val state: ReminderState,
    /** Nu meteen tonen (het tijdstip is bereikt of hooguit een uur voorbij). */
    val fireNow: List<PlannedReminder>,
    /** Alarm zetten op het tijdstip van de herinnering. */
    val schedule: List<PlannedReminder>,
    /** Alarmen die weg moeten (herinnering-id's): de herinnering of taak bestaat niet meer, is afgevinkt of is al getoond. */
    val cancel: Set<String>,
    val snoozeFireNow: List<SnoozedReminder>,
    val snoozeSchedule: List<SnoozedReminder>,
    /** Uitstel-alarmen die weg moeten (herinnering-id's). */
    val snoozeCancel: Set<String>,
)

/**
 * De regels rond plannen, tonen en uitstellen, als zuivere functies. Eén ingang voor alles: [replan]. Een alarm dat
 * afgaat is alleen een seintje "kijk nu"; wat er getoond wordt volgt altijd uit de bewaarde gegevens. Daardoor gaat
 * niets dubbel af en komt alles vanzelf terug na een herstart, een andere tijdzone of een gemist alarm.
 */
object ReminderLogic {
    const val SNOOZE_MS: Long = 10L * 60 * 1000

    /** Zo lang onthouden we wat getoond is. Ruim langer dan het venster van een uur, zodat ook een verzette klok niets herhaalt. */
    const val SHOWN_RETENTION_MS: Long = 7L * 24 * 60 * 60 * 1000

    fun replan(state: ReminderState, nowMs: Long, zone: ZoneId): PlanOutcome {
        val plan = Planner.plan(state.snapshot.tasks, state.snapshot.reminders, nowMs, zone, state.shown.keys)
        val (due, future) = plan.partition { it.triggerAtMs <= nowMs }
        val scheduled = future.associateBy { it.reminderId }

        val snoozeDue = ArrayList<SnoozedReminder>()
        val snoozeFuture = LinkedHashMap<String, SnoozedReminder>()
        val snoozeDropped = HashSet<String>()
        for (s in state.snoozed.values) {
            when {
                s.fireAtMs > nowMs -> snoozeFuture[s.reminderId] = s
                s.fireAtMs >= nowMs - Planner.CATCH_UP_MS -> snoozeDue.add(s)
                else -> snoozeDropped.add(s.reminderId) // te lang geleden (toestel stond uit): niet meer tonen
            }
        }

        val shown = HashMap(state.shown)
        for (p in due) shown[p.key] = p.triggerAtMs
        shown.entries.removeAll { it.value < nowMs - SHOWN_RETENTION_MS }

        return PlanOutcome(
            state = state.copy(scheduled = scheduled, snoozed = snoozeFuture, shown = shown),
            fireNow = due,
            schedule = future,
            cancel = state.scheduled.keys - scheduled.keys,
            snoozeFireNow = snoozeDue,
            snoozeSchedule = snoozeFuture.values.toList(),
            snoozeCancel = snoozeDropped + snoozeDue.map { it.reminderId },
        )
    }

    /**
     * Verwerkt een geslaagde verversing: de nieuwe gegevens vervangen de oude. Uitgestelde meldingen van taken die
     * intussen zijn afgevinkt of verwijderd vervallen. Roep daarna [replan] aan.
     *
     * @return de nieuwe toestand en de herinnering-id's waarvan het uitstel is vervallen
     */
    fun onSynced(state: ReminderState, fresh: SyncSnapshot): Pair<ReminderState, Set<String>> {
        val active = fresh.activeTaskIds()
        val dropped = state.snoozed.values.filter { it.taskId !in active }.mapTo(HashSet()) { it.reminderId }
        return state.copy(snapshot = fresh.trimmed(), snoozed = state.snoozed - dropped) to dropped
    }

    /** "Over 10 minuten": dezelfde melding komt terug op [nowMs] + 10 minuten. */
    fun snooze(state: ReminderState, reminder: PlannedReminder, nowMs: Long): Pair<ReminderState, SnoozedReminder> {
        val snoozed = SnoozedReminder(reminder.reminderId, reminder.taskId, reminder.title, reminder.taskDue, reminder.triggerAtMs, nowMs + SNOOZE_MS)
        return state.copy(snoozed = state.snoozed + (reminder.reminderId to snoozed)) to snoozed
    }

    /** De taak is afgevinkt: uitstel voor die taak vervalt. Geeft de vervallen herinnering-id's terug. */
    fun onTaskCompleted(state: ReminderState, taskId: String): Pair<ReminderState, Set<String>> {
        val dropped = state.snoozed.values.filter { it.taskId == taskId }.mapTo(HashSet()) { it.reminderId }
        return state.copy(snoozed = state.snoozed - dropped) to dropped
    }

    /** Afmelden of een andere gebruiker: alles weg. Wat getoond is onthouden we wel bij [keepShown] (zelfde gebruiker, nieuwe sessie). */
    fun cleared(state: ReminderState, keepShown: Boolean): ReminderState = ReminderState(shown = if (keepShown) state.shown else emptyMap())

    // ---------- "Voltooien" dat nog naar de server moet ----------

    /** Zo lang blijven we het proberen. Daarna geven we het op en zeggen we dat in de melding. */
    const val COMPLETE_RETENTION_MS: Long = 3L * 24 * 60 * 60 * 1000

    /** Onthoudt dat deze taak nog afgevinkt moet worden. Twee keer tikken op dezelfde melding blijft één verzoek. */
    fun queueComplete(state: ReminderState, reminder: PlannedReminder, nowMs: Long): ReminderState {
        if (state.pendingCompletes.containsKey(reminder.reminderId)) return state
        return state.copy(pendingCompletes = state.pendingCompletes + (reminder.reminderId to PendingComplete(reminder, nowMs)))
    }

    /** Klaar (gelukt of definitief geweigerd): niet meer proberen. */
    fun completeSettled(state: ReminderState, reminderId: String): ReminderState =
        if (state.pendingCompletes.containsKey(reminderId)) state.copy(pendingCompletes = state.pendingCompletes - reminderId) else state

    /** Wat al langer dan drie dagen wacht. De aanroeper meldt dat het niet gelukt is en haalt ze met [completeSettled] weg. */
    fun expiredCompletes(state: ReminderState, nowMs: Long): List<PendingComplete> =
        state.pendingCompletes.values.filter { it.queuedAtMs < nowMs - COMPLETE_RETENTION_MS }
}

/** Bewaart de toestand als JSON-tekst. Onleesbare of onvolledige tekst geeft een lege toestand terug in plaats van een fout. */
object StateCodec {
    private const val VERSION = 1L

    fun encode(state: ReminderState): String = Json.stringify(
        mapOf(
            "v" to VERSION,
            "tasks" to state.snapshot.tasks.map { mapOf("id" to it.id, "content" to it.content, "due" to it.due, "checked" to it.checked, "deleted" to it.deleted) },
            "reminders" to state.snapshot.reminders.map {
                mapOf("id" to it.id, "task" to it.taskId, "type" to it.type, "offset" to it.minuteOffset, "due" to it.due, "deleted" to it.deleted)
            },
            "scheduled" to state.scheduled.values.map { planned(it) },
            "snoozed" to state.snoozed.values.map {
                mapOf("id" to it.reminderId, "task" to it.taskId, "title" to it.title, "due" to it.taskDue, "at" to it.originalAtMs, "fire" to it.fireAtMs)
            },
            "shown" to state.shown,
            "completes" to state.pendingCompletes.values.map { planned(it.reminder) + ("queued" to it.queuedAtMs) },
        ),
    )

    fun decode(text: String?): ReminderState {
        val root = Json.parseObject(text) ?: return ReminderState()
        if (root.whole("v") != VERSION) return ReminderState()

        val tasks = objects(root, "tasks").mapNotNull { o ->
            val id = o.text("id")?.takeIf(Ids::isSafeId) ?: return@mapNotNull null
            TaskInfo(id, o.text("content") ?: "", o.text("due"), o.flag("checked"), o.flag("deleted"))
        }
        val reminders = objects(root, "reminders").mapNotNull { o ->
            val id = o.text("id")?.takeIf(Ids::isSafeId) ?: return@mapNotNull null
            val task = o.text("task")?.takeIf(Ids::isSafeId) ?: return@mapNotNull null
            ReminderInfo(id, task, o.text("type") ?: return@mapNotNull null, o.whole("offset"), o.text("due"), o.flag("deleted"))
        }
        val scheduled = objects(root, "scheduled").mapNotNull { readPlanned(it) }
        val completes = objects(root, "completes").mapNotNull { o ->
            PendingComplete(readPlanned(o) ?: return@mapNotNull null, o.whole("queued") ?: return@mapNotNull null)
        }
        val snoozed = objects(root, "snoozed").mapNotNull { o ->
            val id = o.text("id")?.takeIf(Ids::isSafeId) ?: return@mapNotNull null
            val task = o.text("task")?.takeIf(Ids::isSafeId) ?: return@mapNotNull null
            SnoozedReminder(id, task, o.text("title") ?: "", o.text("due"), o.whole("at") ?: return@mapNotNull null, o.whole("fire") ?: return@mapNotNull null)
        }
        val shown = HashMap<String, Long>()
        val rawShown = root.obj("shown")
        if (rawShown != null) {
            for (key in rawShown.keys) rawShown.whole(key)?.let { shown[key] = it }
        }

        return ReminderState(
            snapshot = SyncSnapshot(tasks, reminders),
            scheduled = scheduled.associateBy { it.reminderId },
            snoozed = snoozed.associateBy { it.reminderId },
            shown = shown,
            pendingCompletes = completes.associateBy { it.reminder.reminderId },
        )
    }

    private fun planned(p: PlannedReminder): Map<String, Any?> =
        mapOf("id" to p.reminderId, "task" to p.taskId, "title" to p.title, "at" to p.triggerAtMs, "due" to p.taskDue)

    private fun readPlanned(o: Map<String, Any?>): PlannedReminder? {
        val id = o.text("id")?.takeIf(Ids::isSafeId) ?: return null
        val task = o.text("task")?.takeIf(Ids::isSafeId) ?: return null
        return PlannedReminder(id, task, o.text("title") ?: "", o.whole("at") ?: return null, o.text("due"))
    }

    private fun objects(root: Map<String, Any?>, key: String): List<Map<String, Any?>> = root.list(key)?.mapNotNull { Json.asObject(it) } ?: emptyList()
}
