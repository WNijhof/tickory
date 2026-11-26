package io.github.wnijhof.tickory.core

import java.time.LocalDate

/**
 * Wat er in het venster van een taak (TaskPopupActivity) is veranderd; null is ongewijzigd.
 * @property due een nieuwe dag ([DueChange.date] null = geen datum); het tijdstip en de herhaling blijven zoals ze waren
 * @property projectId naar een ander project (de server zet de taak daar achteraan, zonder sectie)
 */
data class TaskEdits(
    val content: String? = null,
    val description: String? = null,
    val priority: Int? = null,
    val labelIds: List<String>? = null,
    val due: DueChange? = null,
    val projectId: String? = null,
) {
    val isEmpty: Boolean get() = this == TaskEdits()
}

/** Een nieuwe dag voor de taak, of geen datum ([date] null). */
data class DueChange(val date: LocalDate?)

/** De regels van het bewerken in het venster van een taak, als zuivere functies (het venster zelf staat in TaskPopupActivity). */
object TaskEdit {
    /** Zo lang mag de beschrijving op de server zijn. */
    const val MAX_DESCRIPTION = 16000

    /** De titel om te bewerken: zoals hij is, ook als de widget hem korter of op één regel toont. */
    fun editableTitle(task: WidgetTask): String = task.rawContent ?: task.content

    /**
     * Wat er anders is dan [task]. Een lege titel telt niet (een taak heeft altijd een naam, zoals bij Todoist); een beschrijving
     * die niet bekend was ([WidgetTask.description] null) wordt nooit verstuurd, zodat er niets van verloren gaat.
     */
    fun edits(
        task: WidgetTask,
        title: String,
        description: String,
        priority: Int,
        labelIds: List<String>,
        due: DueChange?,
        projectId: String,
    ): TaskEdits {
        val newTitle = title.trim().take(SyncParser.MAX_CONTENT)
        val oldTitle = editableTitle(task)
        val newDescription = description.trimEnd().take(MAX_DESCRIPTION)
        return TaskEdits(
            content = newTitle.takeIf { it.isNotEmpty() && it != oldTitle.trim() },
            description = if (task.description == null || newDescription == task.description.trimEnd()) null else newDescription,
            priority = priority.takeIf { it in 1..4 && it != task.priority },
            labelIds = labelIds.distinct().takeIf { it.toSet() != task.labelIds.toSet() },
            due = due?.takeIf { it.date?.toString() != task.due?.take(10) },
            projectId = projectId.takeIf { Ids.isSafeId(it) && it != task.projectId },
        )
    }

    /**
     * De commando's voor de server: één `task_update` met alles wat veranderd is, en een `task_move` als het project anders is. Elk
     * met een eigen uuid, zodat dubbel versturen het één keer uitvoert.
     */
    fun commands(task: WidgetTask, edits: TaskEdits, uuid: () -> String = { WidgetQueue.newUuid() }): List<SyncCommand> {
        val args = LinkedHashMap<String, Any?>()
        args["id"] = task.id
        edits.content?.let { args["content"] = it }
        edits.description?.let { args["description"] = it }
        edits.priority?.let { args["priority"] = it.toLong() }
        edits.labelIds?.let { args["labels"] = it }
        // zonder de datum zoals de server hem stuurde (een oudere opslag): dan in elk geval het tijdstip van de taak
        edits.due?.let { args["due"] = Reschedule.newDue(task.dueJson ?: task.due?.let { d -> Json.stringify(mapOf("date" to d)) }, it.date) }
        val out = ArrayList<SyncCommand>()
        if (args.size > 1) out.add(SyncCommand("task_update", uuid(), args))
        edits.projectId?.let { out.add(SyncCommand("task_move", uuid(), mapOf("id" to task.id, "project_id" to it))) }
        return out
    }
}
