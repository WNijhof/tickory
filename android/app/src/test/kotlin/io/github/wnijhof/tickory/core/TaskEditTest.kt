package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.WidgetFixtures.task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate

/** Bewerken in het venster van een taak: wat er veranderd is, en welke commando's dat worden. */
class TaskEditTest {
    private val base = task("t1", due = "2026-11-26T09:00", content = "Tandarts bellen", priority = 2, labels = listOf("l1", "l2"))
        .copy(description = "Nummer staat in de mail", dueJson = """{"date":"2026-11-26T09:00","string":"elke dag om 9 uur","lang":"nl","recurrence":{"freq":"daily"}}""")

    private fun edits(
        title: String = "Tandarts bellen",
        description: String = "Nummer staat in de mail",
        priority: Int = 2,
        labels: List<String> = listOf("l1", "l2"),
        due: DueChange? = null,
        project: String = "inbox-project",
        task: WidgetTask = base,
    ) = TaskEdit.edits(task, title, description, priority, labels, due, project)

    @Test
    fun `niets veranderd - geen wijzigingen en geen commando's`() {
        assertTrue(edits().isEmpty)
        // witruimte eromheen, labels in een andere volgorde of dezelfde dag: ook niets
        assertTrue(edits(title = "  Tandarts bellen ", description = "Nummer staat in de mail\n", labels = listOf("l2", "l1"), due = DueChange(LocalDate.of(2026, 11, 26))).isEmpty)
        assertEquals(emptyList<SyncCommand>(), TaskEdit.commands(base, TaskEdits()))
    }

    @Test
    fun `wat veranderd is wordt één task_update, een ander project een task_move`() {
        val e = edits(title = "Tandarts bellen voor controle", description = "", priority = 1, labels = listOf("l2"), due = DueChange(LocalDate.of(2026, 11, 28)), project = "werk")
        assertEquals(TaskEdits("Tandarts bellen voor controle", "", 1, listOf("l2"), DueChange(LocalDate.of(2026, 11, 28)), "werk"), e)
        var n = 0
        val commands = TaskEdit.commands(base, e) { "uuid-${n++}" }
        assertEquals(listOf("task_update", "task_move"), commands.map { it.type })
        assertEquals(listOf("uuid-0", "uuid-1"), commands.map { it.uuid })
        val args = commands[0].args
        assertEquals("t1", args["id"])
        assertEquals("Tandarts bellen voor controle", args["content"])
        assertEquals("", args["description"])
        assertEquals(1L, args["priority"])
        assertEquals(listOf("l2"), args["labels"])
        // het tijdstip en de herhaling blijven, zoals bij Herplannen
        assertEquals(
            """{"date":"2026-11-28T09:00","recurrence":{"freq":"daily"},"string":"elke dag om 9 uur","lang":"nl"}""",
            Json.stringify(args["due"]),
        )
        assertEquals(mapOf("id" to "t1", "project_id" to "werk"), commands[1].args)
        // alleen de prioriteit: alleen dat veld
        assertEquals(mapOf("id" to "t1", "priority" to 4L), TaskEdit.commands(base, edits(priority = 4)).single().args)
        // alleen een ander project: alleen de verplaatsing
        assertEquals(listOf("task_move"), TaskEdit.commands(base, edits(project = "werk")).map { it.type })
        // geen datum meer
        assertEquals(mapOf("id" to "t1", "due" to null), TaskEdit.commands(base, edits(due = DueChange(null))).single().args)
    }

    @Test
    fun `een lege titel telt niet, en een beschrijving die niet bekend is wordt nooit verstuurd`() {
        assertNull(edits(title = "   ").content)
        val unknown = base.copy(description = null)
        assertNull("te lang voor het toestel: niet overschrijven", edits(task = unknown, description = "").description)
        // de volledige titel als de widget hem korter toont
        val long = base.copy(content = "Lange titel…", rawContent = "Lange titel die eigenlijk veel langer is")
        assertEquals("Lange titel die eigenlijk veel langer is", TaskEdit.editableTitle(long))
        assertTrue(edits(task = long, title = "Lange titel die eigenlijk veel langer is").copy(description = null).isEmpty)
        // te lang wordt afgekapt op wat de server toestaat; een onveilig project-id telt niet
        assertEquals(TaskEdit.MAX_DESCRIPTION, edits(description = "x".repeat(20_000)).description!!.length)
        assertNull(edits(project = "a b").projectId)
        assertNull(edits(priority = 7).priority)
    }

    @Test
    fun `de beschrijving en de volledige titel worden bewaard op het toestel`() {
        val raw = """{"sync_token":"1","full_sync":true,"sync_status":{},"me":{"id":"user-anna-0001","username":"anna","name":"Anna","inbox_project_id":"inbox-project"},
            "tasks":[{"id":"t1","project_id":"inbox-project","content":"Twee\nregels","description":"Uitleg","priority":4,"labels":[],"order_key":"a"},
                     {"id":"t2","project_id":"inbox-project","content":"Kort","description":"${"y".repeat(WidgetParser.MAX_SEARCH_DESCRIPTION + 1)}","priority":4,"labels":[],"order_key":"b"},
                     {"id":"t3","project_id":"inbox-project","content":"Leeg","priority":4,"labels":[],"order_key":"c"}],
            "projects":[{"id":"inbox-project","name":"Inbox","order_key":"a"}],"sections":[],"labels":[],"reminders":[]}"""
        val snap = WidgetParser.parse(raw)!!
        val (t1, t2, t3) = snap.tasks
        assertEquals("Twee regels" to "Twee\nregels", t1.content to t1.rawContent)
        assertEquals("Uitleg", t1.description)
        assertNull("te lang om hier te bewerken", t2.description)
        assertNull(t2.rawContent)
        assertEquals("", t3.description)
        // en na opslaan en teruglezen hetzelfde
        assertEquals(snap.tasks, WidgetCodec.decode(WidgetCodec.encode(snap))!!.tasks)
        // bewaard door een oudere versie (zonder descText): zonder beschrijving "", met beschrijving onbekend
        val old = WidgetCodec.encode(snap).replace(Regex(""","descText":(null|"[^"]*")"""), "")
        val back = WidgetCodec.decode(old)!!.tasks
        assertEquals(listOf(null, null, ""), back.map { it.description })
    }
}
