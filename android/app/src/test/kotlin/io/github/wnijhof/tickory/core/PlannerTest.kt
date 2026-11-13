package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class PlannerTest {
    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private val newYork = ZoneId.of("America/New_York")

    private fun utc(iso: String): Long = Instant.parse(iso).toEpochMilli()

    private fun task(id: String = "task-0001", due: String? = "2026-11-13T14:00", content: String = "Tandarts bellen", checked: Boolean = false, deleted: Boolean = false) =
        TaskInfo(id, content, due, checked, deleted)

    private fun relative(minutes: Long?, id: String = "rem-00001", taskId: String = "task-0001", deleted: Boolean = false) =
        ReminderInfo(id, taskId, "relative", minutes, null, deleted)

    private fun absolute(at: String?, id: String = "rem-00002", taskId: String = "task-0001") = ReminderInfo(id, taskId, "absolute", null, at)

    /** Vrijdag 13 november 2026, 10:00 in Amsterdam (wintertijd, UTC+1). */
    private val now = utc("2026-11-13T09:00:00Z")

    private fun plan(tasks: List<TaskInfo>, reminders: List<ReminderInfo>, nowMs: Long = now, zone: ZoneId = amsterdam, shown: Set<String> = emptySet()) =
        Planner.plan(tasks, reminders, nowMs, zone, shown)

    // ---------- relatief en absoluut ----------

    @Test
    fun `relatief - zoveel minuten voor de tijd van de taak`() {
        val result = plan(listOf(task()), listOf(relative(30)))
        assertEquals(1, result.size)
        // 14:00 in Amsterdam is 13:00 UTC; een half uur eerder is 12:30 UTC
        assertEquals(utc("2026-11-13T12:30:00Z"), result[0].triggerAtMs)
        assertEquals("rem-00001", result[0].reminderId)
        assertEquals("task-0001", result[0].taskId)
        assertEquals("Tandarts bellen", result[0].title)
        assertEquals("2026-11-13T14:00", result[0].taskDue)
    }

    @Test
    fun `relatief met nul minuten gaat af op de tijd van de taak`() {
        assertEquals(utc("2026-11-13T13:00:00Z"), plan(listOf(task()), listOf(relative(0))).single().triggerAtMs)
    }

    @Test
    fun `relatief - seconden in de tijd van de taak tellen mee`() {
        val result = plan(listOf(task(due = "2026-11-13T14:00:30")), listOf(relative(0)))
        assertEquals(utc("2026-11-13T13:00:30Z"), result.single().triggerAtMs)
    }

    @Test
    fun `relatief zonder tijd bij de taak - geen herinnering`() {
        assertTrue(plan(listOf(task(due = "2026-11-13")), listOf(relative(30))).isEmpty())
    }

    @Test
    fun `relatief bij een taak zonder datum - geen herinnering`() {
        assertTrue(plan(listOf(task(due = null)), listOf(relative(30))).isEmpty())
    }

    @Test
    fun `absoluut - het eigen tijdstip van de herinnering, los van de taak`() {
        val result = plan(listOf(task(due = null)), listOf(absolute("2026-11-14T09:15")))
        assertEquals(utc("2026-11-14T08:15:00Z"), result.single().triggerAtMs)
        assertNull(result.single().taskDue)
    }

    @Test
    fun `absoluut zonder tijd of zonder datum - geen herinnering`() {
        assertTrue(plan(listOf(task()), listOf(absolute("2026-11-14"))).isEmpty())
        assertTrue(plan(listOf(task()), listOf(absolute(null))).isEmpty())
    }

    @Test
    fun `absoluut negeert minute_offset niet per ongeluk`() {
        val odd = ReminderInfo("rem-00009", "task-0001", "absolute", 45, "2026-11-14T09:15")
        assertEquals(utc("2026-11-14T08:15:00Z"), plan(listOf(task()), listOf(odd)).single().triggerAtMs)
    }

    // ---------- afgevinkt, verwijderd, onbekend ----------

    @Test
    fun `afgevinkte of verwijderde taak - geen herinnering`() {
        assertTrue(plan(listOf(task(checked = true)), listOf(relative(30))).isEmpty())
        assertTrue(plan(listOf(task(deleted = true)), listOf(relative(30))).isEmpty())
    }

    @Test
    fun `verwijderde herinnering of onbekende taak - geen herinnering`() {
        assertTrue(plan(listOf(task()), listOf(relative(30, deleted = true))).isEmpty())
        assertTrue(plan(listOf(task()), listOf(relative(30, taskId = "task-9999"))).isEmpty())
        assertTrue(plan(emptyList(), listOf(relative(30))).isEmpty())
    }

    @Test
    fun `onbekend soort, ontbrekende of onmogelijke minuten - overslaan zonder fout`() {
        val t = listOf(task())
        assertTrue(plan(t, listOf(ReminderInfo("rem-00003", "task-0001", "location", 10, null))).isEmpty())
        assertTrue(plan(t, listOf(ReminderInfo("rem-00003", "task-0001", "", null, null))).isEmpty())
        assertTrue(plan(t, listOf(relative(null))).isEmpty())
        assertTrue(plan(t, listOf(relative(-5))).isEmpty())
        assertTrue(plan(t, listOf(relative(Long.MAX_VALUE))).isEmpty())
    }

    @Test
    fun `ongeldige datums - overslaan zonder fout`() {
        val bad = listOf(
            "2026-02-30T10:00", "2026-13-01T10:00", "2026-11-13T25:00", "2026-11-13T10:61", "2026-11-13T10:00:99",
            "2026-11-13T14:00Z", "2026-11-13T14:00+01:00", "2026-11-13 14:00", "13-11-2026T14:00", "morgen", "", " ", "T14:00",
        )
        for (date in bad) {
            assertTrue("relatief bij taak met datum '$date'", plan(listOf(task(due = date)), listOf(relative(10))).isEmpty())
            assertTrue("absoluut met datum '$date'", plan(listOf(task()), listOf(absolute(date))).isEmpty())
        }
    }

    @Test
    fun `dezelfde herinnering twee keer in de lijst telt een keer`() {
        assertEquals(1, plan(listOf(task()), listOf(relative(30), relative(30))).size)
    }

    // ---------- verleden, toekomst en het venster van een uur ----------

    @Test
    fun `wat hooguit een uur geleden moest afgaan komt nog mee, ouder niet`() {
        val t = listOf(task(due = null))
        // precies een uur geleden: nog wel
        assertEquals(1, plan(t, listOf(absolute("2026-11-13T09:00"))).size)
        // een uur en een minuut geleden: niet meer
        assertTrue(plan(t, listOf(absolute("2026-11-13T08:59"))).isEmpty())
        // een halve minuut geleden: nog wel
        assertEquals(1, plan(t, listOf(absolute("2026-11-13T09:59:30"))).size)
        // gisteren: niet
        assertTrue(plan(t, listOf(absolute("2026-11-12T10:00"))).isEmpty())
    }

    @Test
    fun `de grens van een uur ligt op de milliseconde`() {
        val t = listOf(task(due = null))
        val r = listOf(absolute("2026-11-13T09:00")) // 08:00:00.000 UTC
        val trigger = utc("2026-11-13T08:00:00Z")
        assertEquals(1, plan(t, r, nowMs = trigger + Planner.CATCH_UP_MS).size)
        assertTrue(plan(t, r, nowMs = trigger + Planner.CATCH_UP_MS + 1).isEmpty())
    }

    @Test
    fun `precies nu en in de toekomst`() {
        val t = listOf(task(due = null))
        val exactlyNow = plan(t, listOf(absolute("2026-11-13T10:00"))).single()
        assertEquals(now, exactlyNow.triggerAtMs)
        assertEquals(utc("2026-11-20T07:00:00Z"), plan(t, listOf(absolute("2026-11-20T08:00"))).single().triggerAtMs)
    }

    @Test
    fun `alleen wat binnen dertig dagen valt`() {
        val t = listOf(task(due = null))
        // 13 december 10:00 is precies dertig dagen later (beide wintertijd)
        assertEquals(1, plan(t, listOf(absolute("2026-12-13T10:00"))).size)
        assertTrue(plan(t, listOf(absolute("2026-12-13T10:00:01"))).isEmpty())
        assertTrue(plan(t, listOf(absolute("2027-06-01T10:00"))).isEmpty())
    }

    @Test
    fun `wat al getoond is komt niet terug, tenzij het tijdstip is verschoven`() {
        val t = listOf(task())
        val first = plan(t, listOf(relative(30))).single()
        assertTrue(plan(t, listOf(relative(30)), shown = setOf(first.key)).isEmpty())

        // de taak is een uur opgeschoven: nieuw tijdstip, dus opnieuw plannen
        val moved = plan(listOf(task(due = "2026-11-13T15:00")), listOf(relative(30)), shown = setOf(first.key)).single()
        assertEquals(utc("2026-11-13T13:30:00Z"), moved.triggerAtMs)
        assertFalse(moved.key == first.key)
    }

    @Test
    fun `gesorteerd op tijdstip en hooguit tweehonderd`() {
        val tasks = (1..250).map { task(id = "task-%04d".format(it), due = null) }
        // omgekeerde volgorde aanleveren: nummer 250 gaat het eerst af
        val reminders = (1..250).map { ReminderInfo("rem-%05d".format(it), "task-%04d".format(it), "absolute", null, minutesFromNow(251 - it)) }
        val result = plan(tasks, reminders)
        assertEquals(200, result.size)
        assertEquals("rem-00250", result.first().reminderId)
        assertEquals("rem-00051", result.last().reminderId)
        assertEquals(result.map { it.triggerAtMs }.sorted(), result.map { it.triggerAtMs })
    }

    @Test
    fun `gelijke tijdstippen staan in een vaste volgorde`() {
        val tasks = listOf(task(due = null))
        val a = ReminderInfo("rem-bbbbb", "task-0001", "absolute", null, "2026-11-13T12:00")
        val b = ReminderInfo("rem-aaaaa", "task-0001", "absolute", null, "2026-11-13T12:00")
        assertEquals(listOf("rem-aaaaa", "rem-bbbbb"), plan(tasks, listOf(a, b)).map { it.reminderId })
        assertEquals(listOf("rem-aaaaa", "rem-bbbbb"), plan(tasks, listOf(b, a)).map { it.reminderId })
    }

    private fun minutesFromNow(minutes: Int): String {
        val local = Instant.ofEpochMilli(now).atZone(amsterdam).toLocalDateTime().plusMinutes(minutes.toLong())
        return local.toString().substring(0, 16) // 2026-11-13T10:05
    }

    // ---------- zomertijd: zondag 29 maart 2026, om 02:00 wordt het 03:00 ----------

    @Test
    fun `zomertijd - een tijd die niet bestaat schuift naar voren`() {
        val before = utc("2026-03-28T12:00:00Z")
        val t = listOf(task(due = null))
        fun at(local: String) = plan(t, listOf(absolute(local)), nowMs = before).single().triggerAtMs

        assertEquals("01:59 bestaat nog (wintertijd, UTC+1)", utc("2026-03-29T00:59:00Z"), at("2026-03-29T01:59"))
        assertEquals("02:00 bestaat niet en wordt 03:00 zomertijd", utc("2026-03-29T01:00:00Z"), at("2026-03-29T02:00"))
        assertEquals("02:30 bestaat niet en wordt 03:30 zomertijd", utc("2026-03-29T01:30:00Z"), at("2026-03-29T02:30"))
        assertEquals("03:00 is zomertijd (UTC+2)", utc("2026-03-29T01:00:00Z"), at("2026-03-29T03:00"))
        assertEquals("03:30 is zomertijd (UTC+2)", utc("2026-03-29T01:30:00Z"), at("2026-03-29T03:30"))
    }

    @Test
    fun `zomertijd - relatief telt terug in echte minuten`() {
        val before = utc("2026-03-28T12:00:00Z")
        // taak om 03:15 zomertijd = 01:15 UTC; dertig minuten eerder is 00:45 UTC (01:45 wintertijd)
        val result = plan(listOf(task(due = "2026-03-29T03:15")), listOf(relative(30)), nowMs = before)
        assertEquals(utc("2026-03-29T00:45:00Z"), result.single().triggerAtMs)

        // taak om 02:30 (bestaat niet, wordt 03:30 zomertijd = 01:30 UTC); een uur eerder is 00:30 UTC
        val shifted = plan(listOf(task(due = "2026-03-29T02:30")), listOf(relative(60)), nowMs = before)
        assertEquals(utc("2026-03-29T00:30:00Z"), shifted.single().triggerAtMs)
    }

    // ---------- wintertijd: zondag 25 oktober 2026, om 03:00 wordt het weer 02:00 ----------

    @Test
    fun `wintertijd - een dubbele tijd neemt de eerste`() {
        val before = utc("2026-10-24T12:00:00Z")
        val t = listOf(task(due = null))
        fun at(local: String) = plan(t, listOf(absolute(local)), nowMs = before).single().triggerAtMs

        assertEquals("01:59 is nog zomertijd (UTC+2)", utc("2026-10-24T23:59:00Z"), at("2026-10-25T01:59"))
        assertEquals("02:00 komt twee keer voor: de eerste, zomertijd", utc("2026-10-25T00:00:00Z"), at("2026-10-25T02:00"))
        assertEquals("02:30 komt twee keer voor: de eerste, zomertijd", utc("2026-10-25T00:30:00Z"), at("2026-10-25T02:30"))
        assertEquals("03:00 is wintertijd (UTC+1)", utc("2026-10-25T02:00:00Z"), at("2026-10-25T03:00"))
    }

    @Test
    fun `wintertijd - relatief telt terug in echte minuten`() {
        val before = utc("2026-10-24T12:00:00Z")
        // taak om 02:30 (eerste keer, zomertijd) = 00:30 UTC; een uur eerder is 23:30 UTC de dag ervoor
        val first = plan(listOf(task(due = "2026-10-25T02:30")), listOf(relative(60)), nowMs = before)
        assertEquals(utc("2026-10-24T23:30:00Z"), first.single().triggerAtMs)

        // taak om 03:30 wintertijd = 02:30 UTC; anderhalf uur eerder is 01:00 UTC, de tweede keer dat het 02:00 is
        val second = plan(listOf(task(due = "2026-10-25T03:30")), listOf(relative(90)), nowMs = before)
        assertEquals(utc("2026-10-25T01:00:00Z"), second.single().triggerAtMs)
    }

    // ---------- een andere tijdzone ----------

    @Test
    fun `dezelfde zwevende tijd is in een andere tijdzone een ander moment`() {
        val t = listOf(task(due = "2026-11-13T09:00"))
        val r = listOf(relative(0))
        val early = utc("2026-11-12T00:00:00Z")
        assertEquals(utc("2026-11-13T08:00:00Z"), plan(t, r, nowMs = early, zone = amsterdam).single().triggerAtMs)
        assertEquals(utc("2026-11-13T14:00:00Z"), plan(t, r, nowMs = early, zone = newYork).single().triggerAtMs)
        assertEquals(utc("2026-11-13T03:30:00Z"), plan(t, r, nowMs = early, zone = ZoneId.of("Asia/Kolkata")).single().triggerAtMs)
        assertEquals(utc("2026-11-13T09:00:00Z"), plan(t, r, nowMs = early, zone = ZoneId.of("UTC")).single().triggerAtMs)
    }

    @Test
    fun `een andere tijdzone heeft een eigen zomertijd`() {
        // New York: zondag 8 maart 2026 om 02:00 wordt het 03:00 (UTC-5 wordt UTC-4)
        val before = utc("2026-03-07T12:00:00Z")
        val result = plan(listOf(task(due = null)), listOf(absolute("2026-03-08T02:30")), nowMs = before, zone = newYork)
        assertEquals(utc("2026-03-08T07:30:00Z"), result.single().triggerAtMs)

        // In Amsterdam is die nacht niets aan de hand: 02:30 wintertijd
        val ams = plan(listOf(task(due = null)), listOf(absolute("2026-03-08T02:30")), nowMs = before, zone = amsterdam)
        assertEquals(utc("2026-03-08T01:30:00Z"), ams.single().triggerAtMs)
    }

    @Test
    fun `het venster van een uur volgt de tijdzone`() {
        // Om 09:00 UTC is het in Amsterdam 10:00 en in New York 04:00. Een herinnering van "09:30" is in Amsterdam een half
        // uur geleden (gaat nog af) en ligt in New York ruim vijf uur in de toekomst.
        val t = listOf(task(due = null))
        val r = listOf(absolute("2026-11-13T09:30"))
        assertEquals(utc("2026-11-13T08:30:00Z"), plan(t, r, zone = amsterdam).single().triggerAtMs)
        assertEquals(utc("2026-11-13T14:30:00Z"), plan(t, r, zone = newYork).single().triggerAtMs)
        // "08:30" is in Amsterdam anderhalf uur geleden: te laat
        assertTrue(plan(t, listOf(absolute("2026-11-13T08:30")), zone = amsterdam).isEmpty())
    }

    // ---------- hulpfuncties ----------

    @Test
    fun `datum met en zonder tijd herkennen`() {
        assertTrue(Planner.hasTime("2026-11-13T14:00"))
        assertTrue(Planner.hasTime("2026-11-13T14:00:59"))
        assertFalse(Planner.hasTime("2026-11-13"))
        assertFalse(Planner.hasTime(null))
        assertFalse(Planner.hasTime("2026-11-13T24:00"))
        assertEquals(java.time.LocalDate.of(2026, 11, 13), Planner.localDate("2026-11-13T14:00"))
        assertEquals(java.time.LocalDate.of(2028, 2, 29), Planner.localDate("2028-02-29"))
        assertNull(Planner.localDate("2026-02-29"))
        assertNull(Planner.localDate("onzin"))
    }
}
