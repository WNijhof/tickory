package io.github.wnijhof.tickory.core

import java.time.ZoneId
import java.time.ZonedDateTime

/** Gegevens voor de tests van de widgets. */
object WidgetFixtures {
    val amsterdam: ZoneId = ZoneId.of("Europe/Amsterdam")

    /** Een moment in Amsterdam, bijvoorbeeld at("2026-11-13T09:30"). */
    fun at(local: String, zone: ZoneId = amsterdam): Long = ZonedDateTime.of(java.time.LocalDateTime.parse(local), zone).toInstant().toEpochMilli()

    fun task(
        id: String,
        due: String? = null,
        content: String = "Taak $id",
        project: String = "inbox-project",
        section: String? = null,
        parent: String? = null,
        priority: Int = 4,
        recurring: Boolean = false,
        labels: List<String> = emptyList(),
        order: String = id,
    ) = WidgetTask(id, project, section, parent, content, due, recurring, priority, labels, order)

    fun project(id: String, name: String = "Project $id", parent: String? = null, archived: Boolean = false, order: String = id, readOnly: Boolean = false) =
        WidgetProject(id, name, parent, archived, order, readOnly)

    fun snapshot(
        tasks: List<WidgetTask> = emptyList(),
        projects: List<WidgetProject> = listOf(project("inbox-project", "Inbox")),
        sections: List<WidgetSection> = emptyList(),
        labels: List<WidgetLabel> = emptyList(),
        account: String = "user-anna-0001",
        inbox: String? = "inbox-project",
    ) = WidgetSnapshot(account, inbox, tasks, projects, sections, labels)

    /** Een antwoord van `POST /api/v1/sync` zoals de server het voor een gebruiker stuurt. */
    fun syncBody(
        account: String = "user-anna-0001",
        tasksJson: String = "[]",
        projectsJson: String = """[{"id":"inbox-project","name":"Inbox","parent_id":null,"is_archived":false,"order_key":"a0","is_deleted":false}]""",
        sectionsJson: String = "[]",
        labelsJson: String = "[]",
        remindersJson: String = "[]",
        membersJson: String? = null,
    ) = """{"sync_token":"9","full_sync":true,"sync_status":{},"me":{"id":"$account","username":"anna","name":"Anna","inbox_project_id":"inbox-project"},
        "tasks":$tasksJson,"projects":$projectsJson,"reminders":$remindersJson,"sections":$sectionsJson,"labels":$labelsJson${if (membersJson != null) ",\"members\":$membersJson" else ""}}"""

    fun taskJson(
        id: String,
        due: String? = null,
        content: String = "Taak $id",
        project: String = "inbox-project",
        checked: Boolean = false,
        deleted: Boolean = false,
        recurring: Boolean = false,
        priority: Int = 4,
    ): String {
        val dueJson = if (due == null) "null" else """{"date":"$due"${if (recurring) ""","recurrence":{"freq":"weekly","byweekday":[5]}""" else ""}}"""
        return """{"id":"$id","project_id":"$project","section_id":null,"parent_id":null,"content":"$content","due":$dueJson,"priority":$priority,"labels":[],"checked":$checked,"is_deleted":$deleted,"order_key":"a$id"}"""
    }
}
