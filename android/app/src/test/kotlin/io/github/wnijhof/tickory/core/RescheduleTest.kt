package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.WidgetFixtures.task
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDate

/** Herplannen vanuit een widget: de snelle keuzes en wat er naar de server gaat (zoals reschedule in client/core/quickDates.js). */
class RescheduleTest {
    private val thursday = LocalDate.parse("2026-11-19")

    @Test
    fun `de snelle keuzes - morgen, het weekend en volgende week volgens de gekozen weekdagen`() {
        val c = Reschedule.choices(thursday)
        assertEquals(LocalDate.parse("2026-11-20"), c.tomorrow)
        assertEquals("zaterdag", LocalDate.parse("2026-11-21"), c.weekend)
        assertEquals("maandag", LocalDate.parse("2026-11-23"), c.nextWeek)
        val custom = Reschedule.choices(thursday, nextWeekDay = 4, weekendDay = 5)
        assertEquals("op de dag zelf over een week", LocalDate.parse("2026-11-26"), custom.nextWeek)
        assertEquals("vrijdag", LocalDate.parse("2026-11-20"), custom.weekend)
        assertEquals("op zaterdag is het weekend vandaag", LocalDate.parse("2026-11-21"), Reschedule.choices(LocalDate.parse("2026-11-21")).weekend)
    }

    @Test
    fun `de nieuwe datum houdt het tijdstip en de herhaling`() {
        assertEquals(mapOf("date" to "2026-11-20"), Reschedule.newDue("""{"date":"2026-11-12"}""", LocalDate.parse("2026-11-20")))
        assertEquals(mapOf("date" to "2026-11-20T09:30"), Reschedule.newDue("""{"date":"2026-11-12T09:30"}""", LocalDate.parse("2026-11-20")))
        val recurring = Reschedule.newDue("""{"date":"2026-11-12","string":"elke dag","lang":"nl","recurrence":{"freq":"daily"}}""", LocalDate.parse("2026-11-20"))!!
        assertEquals("2026-11-20", recurring["date"])
        assertEquals(mapOf("freq" to "daily"), recurring["recurrence"])
        assertEquals("elke dag", recurring["string"])
        assertEquals("nl", recurring["lang"])
        assertNull("geen datum", Reschedule.newDue("""{"date":"2026-11-12"}""", null))
        assertEquals("zonder bekende datum: alleen de nieuwe", mapOf("date" to "2026-11-20"), Reschedule.newDue(null, LocalDate.parse("2026-11-20")))
    }

    @Test
    fun `een task_update per taak, elk met een eigen uuid`() {
        var n = 0
        val tasks = listOf(task("a", "2026-11-12").copy(dueJson = """{"date":"2026-11-12T08:00"}"""), task("b", "2026-11-10"))
        val cmds = Reschedule.commands(tasks, LocalDate.parse("2026-11-19")) { "uuid-${++n}" }
        assertEquals(listOf("task_update", "task_update"), cmds.map { it.type })
        assertEquals(listOf("uuid-1", "uuid-2"), cmds.map { it.uuid })
        assertEquals(mapOf("id" to "a", "due" to mapOf("date" to "2026-11-19T08:00")), cmds[0].args)
        assertEquals(mapOf("id" to "b", "due" to mapOf("date" to "2026-11-19")), cmds[1].args)
        assertEquals(mapOf("id" to "a", "due" to null), Reschedule.commands(tasks.take(1), null) { "x" }[0].args)
    }

    @Test
    fun `de verversing levert herinneringen, opmerkingen, beschrijving, afgevinkte subtaken en de datum mee`() {
        val body = WidgetFixtures.syncBody(
            tasksJson = """[
              {"id":"t1","project_id":"inbox-project","content":"Ouder","description":"iets","priority":4,"due":{"date":"2026-11-12T09:00","string":"elke dag","recurrence":{"freq":"daily"}},"is_deleted":false,"checked":false},
              {"id":"k1","project_id":"inbox-project","parent_id":"t1","content":"Af","priority":4,"is_deleted":false,"checked":true},
              {"id":"k2","project_id":"inbox-project","parent_id":"t1","content":"Open","priority":4,"is_deleted":false,"checked":false}
            ]""",
            remindersJson = """[{"id":"r1","task_id":"t1","type":"absolute","due":{"date":"2026-11-12T08:00"},"is_deleted":false},{"id":"r2","task_id":"t1","type":"absolute","due":{"date":"2026-11-12T08:30"},"is_deleted":false}]""",
        ).trimEnd().dropLast(1) + ""","comments":[{"id":"c1","task_id":"t1","is_deleted":false},{"id":"c2","task_id":"t1","is_deleted":true}],"settings":[{"id":"s","owner_id":"user-anna-0001","is_deleted":false,"general":{"next_week":3,"weekend":7}}]}"""
        val s = WidgetParser.parse(body)!!
        val t = s.tasks.first { it.id == "t1" }
        assertEquals(2, t.reminders)
        assertEquals(1, t.comments)
        assertEquals(true, t.hasDescription)
        assertEquals(1, t.doneSubtasks)
        assertEquals("elke dag", Json.parseObject(t.dueJson)!!.text("string"))
        assertEquals(3, s.nextWeekDay)
        assertEquals(7, s.weekendDay)
        // en het blijft staan na bewaren op het toestel
        val back = WidgetCodec.decode(WidgetCodec.encode(s))!!
        assertEquals(t, back.tasks.first { it.id == "t1" })
        assertEquals(3 to 7, back.nextWeekDay to back.weekendDay)
    }
}
