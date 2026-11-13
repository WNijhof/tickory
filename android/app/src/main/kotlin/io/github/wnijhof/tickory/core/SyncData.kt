package io.github.wnijhof.tickory.core

/** Wat we van een taak nodig hebben om herinneringen te plannen. [due] is de datum zoals de server die geeft. */
data class TaskInfo(
    val id: String,
    val content: String,
    val due: String?,
    val checked: Boolean = false,
    val deleted: Boolean = false,
)

data class ReminderInfo(
    val id: String,
    val taskId: String,
    /** "relative" (zoveel minuten voor de tijd van de taak) of "absolute" (eigen datum en tijd). */
    val type: String,
    val minuteOffset: Long?,
    val due: String?,
    val deleted: Boolean = false,
)

data class SyncSnapshot(val tasks: List<TaskInfo>, val reminders: List<ReminderInfo>) {
    /** De taken die nu open staan (niet afgevinkt, niet verwijderd). */
    fun activeTaskIds(): Set<String> = tasks.filter { !it.checked && !it.deleted }.mapTo(HashSet()) { it.id }

    /** Alleen wat nodig is om te plannen: de herinneringen die nog bestaan en de taken waar ze bij horen. */
    fun trimmed(): SyncSnapshot {
        val liveReminders = reminders.filter { !it.deleted }
        val wanted = liveReminders.mapTo(HashSet()) { it.taskId }
        return SyncSnapshot(tasks.filter { it.id in wanted && !it.deleted }, liveReminders)
    }

    companion object {
        val EMPTY = SyncSnapshot(emptyList(), emptyList())
    }
}

/** De uitkomst van één commando in het antwoord van de server (`sync_status[uuid]`). */
sealed class CommandStatus {
    object Ok : CommandStatus()
    data class Rejected(val code: String, val message: String) : CommandStatus()

    /** Het antwoord noemt dit commando niet, of in een vorm die we niet kennen. */
    object Missing : CommandStatus()
}

/** Leest antwoorden van POST /api/v1/sync. Alles wat ontbreekt of een onverwachte vorm heeft, wordt overgeslagen; niets gooit. */
object SyncParser {
    const val MAX_TITLE_LENGTH = 200

    /**
     * De taken en herinneringen uit een sync-antwoord, of null als het antwoord onbruikbaar is (geen JSON-object, of
     * de lijsten "tasks" en "reminders" ontbreken). Bij null moet de aanroeper het bestaande plan laten staan.
     * Losse onderdelen met een fout (geen id, verkeerd soort veld) worden overgeslagen.
     */
    fun parseSnapshot(body: String?): SyncSnapshot? {
        val root = Json.parseObject(body) ?: return null
        val rawTasks = root.list("tasks") ?: return null
        val rawReminders = root.list("reminders") ?: return null

        val tasks = rawTasks.mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            TaskInfo(
                id = id,
                content = cleanTitle(o.text("content")),
                due = o.obj("due")?.text("date"),
                checked = o.flag("checked"),
                deleted = o.flag("is_deleted"),
            )
        }
        val reminders = rawReminders.mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            val taskId = o.text("task_id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            val type = o.text("type") ?: return@mapNotNull null
            ReminderInfo(
                id = id,
                taskId = taskId,
                type = type,
                minuteOffset = o.whole("minute_offset"),
                due = o.obj("due")?.text("date"),
                deleted = o.flag("is_deleted"),
            )
        }
        return SyncSnapshot(tasks, reminders)
    }

    /** De uitkomst van het commando met dit [uuid]. */
    fun commandStatus(body: String?, uuid: String): CommandStatus {
        val status = Json.parseObject(body)?.obj("sync_status") ?: return CommandStatus.Missing
        return when (val value = status[uuid]) {
            "ok" -> CommandStatus.Ok
            is Map<*, *> -> {
                val o = Json.asObject(value) ?: return CommandStatus.Missing
                CommandStatus.Rejected(o.text("error_code") ?: "UNKNOWN", o.text("error") ?: "")
            }
            else -> CommandStatus.Missing
        }
    }

    /** Eén regel, zonder overbodige witruimte, en niet langer dan een melding kan tonen. */
    fun cleanTitle(content: String?): String {
        val oneLine = (content ?: "").replace(Regex("\\s+"), " ").trim()
        if (oneLine.length <= MAX_TITLE_LENGTH) return oneLine
        var cut = oneLine.substring(0, MAX_TITLE_LENGTH - 1)
        if (cut.last().isHighSurrogate()) cut = cut.dropLast(1) // geen half teken (emoji) aan het eind
        return cut.trimEnd() + "…"
    }
}
