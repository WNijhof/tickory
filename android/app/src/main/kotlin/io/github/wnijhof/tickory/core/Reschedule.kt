package io.github.wnijhof.tickory.core

import java.time.LocalDate

/**
 * Herplannen vanuit een widget (de knop naast "Over tijd"), zoals in Todoist: de te late taken in één keer naar een andere dag. Zuivere Kotlin:
 * de snelle keuzes (zoals `quickDates` in client/core/quickDates.js) en de commando's voor de server (zoals `reschedule` daar: het tijdstip
 * blijft, een herhaling blijft herhalen).
 */
object Reschedule {
    /** De snelle keuzes vanaf [today]: morgen, het weekend en volgende week volgens de gekozen weekdagen (ISO 1-7). */
    data class Choices(val today: LocalDate, val tomorrow: LocalDate, val weekend: LocalDate, val nextWeek: LocalDate)

    fun choices(today: LocalDate, nextWeekDay: Int = 1, weekendDay: Int = 6): Choices {
        val iso = today.dayOfWeek.value
        val weekend = today.plusDays(((weekendDay - iso + 7) % 7).toLong()) // op de dag zelf: vandaag
        val next = ((nextWeekDay - iso + 7) % 7).let { if (it == 0) 7 else it } // op de dag zelf: over een week
        return Choices(today, today.plusDays(1), weekend, today.plusDays(next.toLong()))
    }

    /**
     * De nieuwe datum van een taak: [date] met het tijdstip dat de taak had; een herhaling (met haar tekst en taal) blijft staan. null = geen
     * datum meer. [dueJson] is de datum zoals de server hem stuurde (WidgetTask.dueJson).
     */
    fun newDue(dueJson: String?, date: LocalDate?): Map<String, Any?>? {
        if (date == null) return null
        val old = Json.parseObject(dueJson)
        val oldDate = old?.text("date")
        val time = if (oldDate != null && oldDate.length > 10) oldDate.substring(10) else ""
        val out = linkedMapOf<String, Any?>("date" to "$date$time")
        val recurrence = old?.obj("recurrence")
        if (recurrence != null) {
            out["recurrence"] = recurrence
            old.text("string")?.let { out["string"] = it }
            old.text("lang")?.let { out["lang"] = it }
        }
        return out
    }

    /** De commando's voor de server: één `task_update` per taak, elk met een eigen uuid (dubbel versturen voert het één keer uit). */
    fun commands(tasks: List<WidgetTask>, date: LocalDate?, uuid: () -> String = { WidgetQueue.newUuid() }): List<SyncCommand> =
        tasks.map { t -> SyncCommand("task_update", uuid(), mapOf("id" to t.id, "due" to newDue(t.dueJson, date))) }
}
