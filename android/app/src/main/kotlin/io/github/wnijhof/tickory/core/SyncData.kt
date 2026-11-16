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
    /** Alleen bij type "location": de plaats, en "enter" (bij aankomst) of "leave" (bij vertrek). */
    val placeId: String? = null,
    val trigger: String? = null,
)

data class SyncSnapshot(val tasks: List<TaskInfo>, val reminders: List<ReminderInfo>, val places: List<PlaceInfo> = emptyList()) {
    /** De taken die nu open staan (niet afgevinkt, niet verwijderd). */
    fun activeTaskIds(): Set<String> = tasks.filter { !it.checked && !it.deleted }.mapTo(HashSet()) { it.id }

    /** Alleen wat nodig is om te plannen: de herinneringen die nog bestaan en de taken waar ze bij horen. */
    fun trimmed(): SyncSnapshot {
        val liveReminders = reminders.filter { !it.deleted }
        val wanted = liveReminders.mapTo(HashSet()) { it.taskId }
        val wantedPlaces = liveReminders.filter { it.type == GeoReminders.TYPE }.mapNotNullTo(HashSet()) { it.placeId }
        return SyncSnapshot(tasks.filter { it.id in wanted && !it.deleted }, liveReminders, places.filter { it.id in wantedPlaces && !it.deleted })
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
    fun parseSnapshot(body: String?, now: java.time.LocalDateTime = java.time.LocalDateTime.now()): SyncSnapshot? {
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
                placeId = o.text("place_id")?.takeIf { Ids.isSafeId(it) },
                trigger = o.text("trigger"),
            )
        }
        // De plaatsen zijn optioneel: een oudere server kent ze niet.
        val places = (root.list("places") ?: emptyList()).mapNotNull { entry ->
            val o = Json.asObject(entry) ?: return@mapNotNull null
            val id = o.text("id")?.takeIf { Ids.isSafeId(it) } ?: return@mapNotNull null
            if (o.flag("is_deleted")) return@mapNotNull PlaceInfo(id, "", 0.0, 0.0, 0, deleted = true)
            val lat = o.real("lat") ?: return@mapNotNull null
            val lon = o.real("lon") ?: return@mapNotNull null
            if (!Geo.validCoordinates(lat, lon)) return@mapNotNull null
            val radius = o.whole("radius")?.takeIf { it in 1..100_000 }?.toInt() ?: return@mapNotNull null
            PlaceInfo(id, cleanTitle(o.text("name")), lat, lon, radius)
        }
        // Herinneringen op notities (optioneel: een oudere server kent geen notities). Een notitie wordt een "taak" zonder datum
        // (note_<id>) met per komende keer een herinnering van het type "absolute"; zie NoteReminders.
        val noteTasks = ArrayList<TaskInfo>()
        val noteReminders = ArrayList<ReminderInfo>()
        // Een notitie die iemand met je deelde, heeft de herinnering van de eigenaar: die gaat hier niet af.
        val me = root.obj("me")?.text("id")
        for (entry in root.list("notes") ?: emptyList()) {
            val o = Json.asObject(entry) ?: continue
            val id = o.text("id")?.takeIf { Ids.isSafeId(NoteReminders.reminderIdFor(it, "2000-01-01T00:00")) } ?: continue
            if (o.flag("is_deleted") || o.text("trashed_at") != null) continue
            val owner = o.text("owner_id")
            if (me != null && owner != null && owner != me) continue
            // vanaf een uur geleden, net als bij taken: een herinnering die net gemist is (toestel uit) komt nog
            val times = NoteReminders.upcoming(o.text("remind_at"), o.text("remind_repeat"), now.minusHours(1))
            if (times.isEmpty()) continue
            val taskId = NoteReminders.taskIdFor(id)
            noteTasks.add(TaskInfo(taskId, cleanTitle(NoteReminders.headline(o.text("title"), o.text("content"))), due = null))
            for (at in times) {
                val floating = NoteReminders.format(at)
                noteReminders.add(ReminderInfo(NoteReminders.reminderIdFor(id, floating), taskId, "absolute", null, floating))
            }
        }
        return SyncSnapshot(tasks + noteTasks, reminders + noteReminders, places)
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
