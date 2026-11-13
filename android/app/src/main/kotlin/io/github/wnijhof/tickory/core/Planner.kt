package io.github.wnijhof.tickory.core

import java.time.DateTimeException
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZonedDateTime

/** Eén herinnering die moet afgaan: welke, bij welke taak, met welke titel en wanneer (milliseconden sinds 1970, UTC). */
data class PlannedReminder(
    val reminderId: String,
    val taskId: String,
    val title: String,
    val triggerAtMs: Long,
    /** De datum van de taak zoals de server die gaf; voor de tekst van de melding ("vandaag 14:00"). */
    val taskDue: String? = null,
) {
    /** Herkent "deze herinnering op dit tijdstip". Verschuift het tijdstip, dan is het een nieuwe sleutel en gaat hij opnieuw af. */
    val key: String get() = "$reminderId@$triggerAtMs"
}

/**
 * Rekent uit welke herinneringen wanneer moeten afgaan. Zuivere Kotlin: geen Android, geen klok, geen opslag.
 *
 * Datums van de server zijn "zwevende" lokale tijden ("2026-11-13T14:00", zonder tijdzone): 14:00 op de klok van het
 * toestel. Bij de overgang naar zomertijd bestaat een uur niet; zo'n tijd schuift naar voren (02:30 wordt 03:30). Bij de
 * overgang naar wintertijd komt een uur twee keer voor; dan geldt de eerste keer.
 */
object Planner {
    const val CATCH_UP_MS: Long = 60L * 60 * 1000
    const val HORIZON_MS: Long = 30L * 24 * 60 * 60 * 1000
    const val MAX_PLANNED: Int = 200

    /** Langer dan dit vooraf kan een relatieve herinnering niet zijn (de server staat hooguit een jaar toe). */
    private const val MAX_OFFSET_MINUTES: Long = 60L * 24 * 366

    private val DATE = Regex("^(\\d{4})-(\\d{2})-(\\d{2})(?:T(\\d{2}):(\\d{2})(?::(\\d{2}))?)?$")

    /**
     * @param alreadyShown sleutels ([PlannedReminder.key]) van wat al getoond is; die komen niet terug
     * @return gesorteerd op tijdstip: alles wat tussen "een uur geleden" en "over 30 dagen" valt, hooguit [max] stuks.
     *   Wat al voorbij is (tijdstip <= [nowMs]) hoort meteen af te gaan.
     */
    fun plan(
        tasks: List<TaskInfo>,
        reminders: List<ReminderInfo>,
        nowMs: Long,
        zone: ZoneId,
        alreadyShown: Set<String> = emptySet(),
        catchUpMs: Long = CATCH_UP_MS,
        horizonMs: Long = HORIZON_MS,
        max: Int = MAX_PLANNED,
    ): List<PlannedReminder> {
        val tasksById = HashMap<String, TaskInfo>()
        for (t in tasks) tasksById[t.id] = t

        val seen = HashSet<String>()
        val out = ArrayList<PlannedReminder>()
        for (r in reminders) {
            if (r.deleted || !seen.add(r.id)) continue
            val task = tasksById[r.taskId] ?: continue
            if (task.deleted || task.checked) continue
            val at = triggerTime(r, task, zone) ?: continue
            if (at < nowMs - catchUpMs || at > nowMs + horizonMs) continue
            val planned = PlannedReminder(r.id, task.id, task.content, at, task.due)
            if (planned.key in alreadyShown) continue
            out.add(planned)
        }
        out.sortWith(compareBy<PlannedReminder> { it.triggerAtMs }.thenBy { it.reminderId })
        return if (out.size > max) out.subList(0, max).toList() else out
    }

    /** Het tijdstip waarop deze herinnering moet afgaan, of null als dat niet te bepalen is. */
    fun triggerTime(reminder: ReminderInfo, task: TaskInfo, zone: ZoneId): Long? = when (reminder.type) {
        "relative" -> {
            val offset = reminder.minuteOffset
            val due = localDateTime(task.due) // alleen als de taak een tijd heeft
            if (offset == null || offset < 0 || offset > MAX_OFFSET_MINUTES || due == null) {
                null
            } else {
                // Aftrekken op de echte tijdlijn, niet op de klok: "30 minuten voor 03:15" op de dag dat de zomertijd
                // ingaat is 01:45 wintertijd, een half uur eerder; op de klok zou 02:45 uitkomen, en dat bestaat die nacht niet.
                toEpochMs(due, zone) - offset * 60_000L
            }
        }
        "absolute" -> localDateTime(reminder.due)?.let { toEpochMs(it, zone) }
        else -> null
    }

    /** Heeft deze datum ook een tijd ("2026-11-13T14:00")? Alleen een dag ("2026-11-13") geeft false. */
    fun hasTime(date: String?): Boolean = localDateTime(date) != null

    /** Datum mét tijd als lokale datum/tijd; null bij alleen een dag of bij iets ongeldigs (30 februari, 25:00). */
    fun localDateTime(date: String?): LocalDateTime? {
        val m = DATE.matchEntire(date ?: return null) ?: return null
        val g = m.groupValues
        if (g[4].isEmpty()) return null
        return try {
            LocalDateTime.of(g[1].toInt(), g[2].toInt(), g[3].toInt(), g[4].toInt(), g[5].toInt(), if (g[6].isEmpty()) 0 else g[6].toInt())
        } catch (_: DateTimeException) {
            null
        }
    }

    /** Alleen de dag uit een datum met of zonder tijd; null bij iets ongeldigs. */
    fun localDate(date: String?): java.time.LocalDate? {
        val m = DATE.matchEntire(date ?: return null) ?: return null
        val g = m.groupValues
        return try {
            java.time.LocalDate.of(g[1].toInt(), g[2].toInt(), g[3].toInt())
        } catch (_: DateTimeException) {
            null
        }
    }

    /**
     * Lokale tijd naar een moment. ZonedDateTime.ofLocal doet precies wat we willen: een tijd in het gat van de
     * zomertijd schuift de lengte van het gat naar voren, en bij een dubbele tijd wint de eerste (de vroegere offset).
     */
    fun toEpochMs(local: LocalDateTime, zone: ZoneId): Long = ZonedDateTime.ofLocal(local, zone, null).toInstant().toEpochMilli()
}
