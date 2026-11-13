package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant
import java.time.ZoneId

class ReminderLogicTest {
    private val amsterdam = ZoneId.of("Europe/Amsterdam")
    private val minute = 60_000L
    private val hour = 60 * minute

    private fun utc(iso: String): Long = Instant.parse(iso).toEpochMilli()

    /** 10:00 in Amsterdam. */
    private val now = utc("2026-11-13T09:00:00Z")

    /** Taak om 14:00 met een herinnering een half uur ervoor: gaat af om 13:30 (12:30 UTC). */
    private val trigger = utc("2026-11-13T12:30:00Z")

    private fun snapshot(due: String? = "2026-11-13T14:00", checked: Boolean = false, withReminder: Boolean = true) = SyncSnapshot(
        tasks = listOf(TaskInfo("task-0001", "Tandarts bellen", due, checked)),
        reminders = if (withReminder) listOf(ReminderInfo("rem-00001", "task-0001", "relative", 30, null)) else emptyList(),
    )

    private fun synced(state: ReminderState, fresh: SyncSnapshot): ReminderState = ReminderLogic.onSynced(state, fresh).first

    @Test
    fun `een herinnering in de toekomst krijgt een alarm en gaat nog niet af`() {
        val outcome = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam)
        assertTrue(outcome.fireNow.isEmpty())
        assertEquals(listOf("rem-00001"), outcome.schedule.map { it.reminderId })
        assertEquals(trigger, outcome.schedule.single().triggerAtMs)
        assertEquals(setOf("rem-00001"), outcome.state.scheduled.keys)
        assertTrue(outcome.cancel.isEmpty())
        assertTrue(outcome.state.shown.isEmpty())
    }

    @Test
    fun `op het tijdstip gaat hij af, en daarna nooit meer`() {
        var state = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam).state

        // het alarm gaat af: opnieuw plannen op dat moment toont de melding
        val fired = ReminderLogic.replan(state, trigger, amsterdam)
        assertEquals(listOf("rem-00001"), fired.fireNow.map { it.reminderId })
        assertEquals("Tandarts bellen", fired.fireNow.single().title)
        assertEquals("2026-11-13T14:00", fired.fireNow.single().taskDue)
        assertTrue(fired.schedule.isEmpty())
        assertEquals("het alarm is verbruikt en moet uit de lijst", setOf("rem-00001"), fired.cancel)
        assertTrue(fired.state.scheduled.isEmpty())
        state = fired.state

        // een seconde later, tien minuten later, na een nieuwe verversing met dezelfde gegevens: niets meer
        for (later in listOf(trigger + 1000, trigger + 10 * minute, trigger + 59 * minute)) {
            val again = ReminderLogic.replan(state, later, amsterdam)
            assertTrue("op +${(later - trigger) / 1000}s", again.fireNow.isEmpty())
            assertTrue(again.schedule.isEmpty())
            state = again.state
        }
        val afterSync = ReminderLogic.replan(synced(state, snapshot()), trigger + 5 * minute, amsterdam)
        assertTrue(afterSync.fireNow.isEmpty())
        assertTrue(afterSync.schedule.isEmpty())
    }

    @Test
    fun `twee keer achter elkaar plannen zonder dat er iets verandert geeft twee keer hetzelfde`() {
        val first = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam)
        val second = ReminderLogic.replan(first.state, now + minute, amsterdam)
        assertEquals(first.schedule, second.schedule)
        assertEquals(first.state, second.state)
        assertTrue(second.cancel.isEmpty())
    }

    @Test
    fun `gemist tot een uur geleden gaat alsnog af, ouder niet`() {
        // de telefoon stond uit en gaat 40 minuten na het tijdstip weer aan
        val late = ReminderLogic.replan(synced(ReminderState(), snapshot()), trigger + 40 * minute, amsterdam)
        assertEquals(listOf("rem-00001"), late.fireNow.map { it.reminderId })

        // twee uur te laat: niet meer tonen, en ook geen alarm
        val tooLate = ReminderLogic.replan(synced(ReminderState(), snapshot()), trigger + 2 * hour, amsterdam)
        assertTrue(tooLate.fireNow.isEmpty())
        assertTrue(tooLate.schedule.isEmpty())
    }

    @Test
    fun `herinnering weg, taak afgevinkt of taak zonder tijd - het alarm wordt geannuleerd`() {
        val planned = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam).state
        assertEquals(setOf("rem-00001"), planned.scheduled.keys)

        for (fresh in listOf(snapshot(withReminder = false), snapshot(checked = true), snapshot(due = "2026-11-13"), snapshot(due = null), SyncSnapshot.EMPTY)) {
            val outcome = ReminderLogic.replan(synced(planned, fresh), now + minute, amsterdam)
            assertEquals(setOf("rem-00001"), outcome.cancel)
            assertTrue(outcome.schedule.isEmpty())
            assertTrue(outcome.fireNow.isEmpty())
            assertTrue(outcome.state.scheduled.isEmpty())
        }
    }

    @Test
    fun `een verzette taak krijgt een nieuw alarm, ook als de oude al was afgegaan`() {
        var state = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam).state
        state = ReminderLogic.replan(state, trigger, amsterdam).state // afgegaan

        // de taak gaat naar 16:00: de herinnering hoort om 15:30 opnieuw af te gaan
        val moved = ReminderLogic.replan(synced(state, snapshot(due = "2026-11-13T16:00")), trigger + minute, amsterdam)
        assertTrue(moved.fireNow.isEmpty())
        assertEquals(utc("2026-11-13T14:30:00Z"), moved.schedule.single().triggerAtMs)
    }

    @Test
    fun `een terugkerende taak die doorschuift gaat de volgende dag weer af`() {
        var state = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam).state
        state = ReminderLogic.replan(state, trigger, amsterdam).state
        // voltooid op de server: de datum schuift een dag op, de taak blijft open
        val next = ReminderLogic.replan(synced(state, snapshot(due = "2026-11-14T14:00")), trigger + minute, amsterdam)
        assertEquals(utc("2026-11-14T12:30:00Z"), next.schedule.single().triggerAtMs)
        assertTrue(next.fireNow.isEmpty())
    }

    @Test
    fun `in een andere tijdzone verschuift het alarm mee met de klok`() {
        val state = ReminderLogic.replan(synced(ReminderState(), snapshot()), now, amsterdam).state
        // de gebruiker landt in New York: "13:30 op de klok" is daar 18:30 UTC
        val moved = ReminderLogic.replan(state, now, ZoneId.of("America/New_York"))
        assertEquals(utc("2026-11-13T18:30:00Z"), moved.schedule.single().triggerAtMs)
        assertTrue(moved.cancel.isEmpty()) // zelfde herinnering, alleen een ander tijdstip
    }

    @Test
    fun `wat getoond is wordt een week onthouden en daarna opgeruimd`() {
        var state = ReminderLogic.replan(synced(ReminderState(), snapshot()), trigger, amsterdam).state
        assertEquals(1, state.shown.size)
        state = ReminderLogic.replan(state, trigger + 6 * 24 * hour, amsterdam).state
        assertEquals(1, state.shown.size)
        state = ReminderLogic.replan(state, trigger + 8 * 24 * hour, amsterdam).state
        assertTrue(state.shown.isEmpty())
    }

    // ---------- uitstellen ----------

    private fun firedState(): Pair<ReminderState, PlannedReminder> {
        val fired = ReminderLogic.replan(synced(ReminderState(), snapshot()), trigger, amsterdam)
        return fired.state to fired.fireNow.single()
    }

    @Test
    fun `uitstellen - dezelfde melding komt tien minuten later terug, een keer`() {
        val (afterFire, reminder) = firedState()
        val tapped = trigger + 2 * minute
        val (state, snoozed) = ReminderLogic.snooze(afterFire, reminder, tapped)
        assertEquals(tapped + 10 * minute, snoozed.fireAtMs)
        assertEquals(trigger, snoozed.originalAtMs)

        // voor die tijd: het alarm staat klaar, er gaat niets af
        val waiting = ReminderLogic.replan(state, tapped + 5 * minute, amsterdam)
        assertTrue(waiting.snoozeFireNow.isEmpty())
        assertTrue(waiting.fireNow.isEmpty())
        assertEquals(listOf("rem-00001"), waiting.snoozeSchedule.map { it.reminderId })

        // op de tijd: opnieuw tonen, met dezelfde gegevens
        val due = ReminderLogic.replan(waiting.state, tapped + 10 * minute, amsterdam)
        assertEquals(listOf(snoozed), due.snoozeFireNow)
        assertEquals(reminder, due.snoozeFireNow.single().asPlanned())
        assertTrue(due.state.snoozed.isEmpty())

        // daarna niet nog eens
        val after = ReminderLogic.replan(due.state, tapped + 11 * minute, amsterdam)
        assertTrue(after.snoozeFireNow.isEmpty())
        assertTrue(after.snoozeSchedule.isEmpty())
    }

    @Test
    fun `uitstel dat ruim te laat komt, vervalt`() {
        val (afterFire, reminder) = firedState()
        val (state, _) = ReminderLogic.snooze(afterFire, reminder, trigger)
        // telefoon uit; 50 minuten na het uitsteltijdstip weer aan: nog tonen
        val late = ReminderLogic.replan(state, trigger + 10 * minute + 50 * minute, amsterdam)
        assertEquals(1, late.snoozeFireNow.size)
        // drie uur later: laten vervallen en het alarm opruimen
        val tooLate = ReminderLogic.replan(state, trigger + 10 * minute + 3 * hour, amsterdam)
        assertTrue(tooLate.snoozeFireNow.isEmpty())
        assertTrue(tooLate.state.snoozed.isEmpty())
        assertEquals(setOf("rem-00001"), tooLate.snoozeCancel)
    }

    @Test
    fun `uitstel vervalt als de taak intussen is afgevinkt of verwijderd, en blijft als de taak open is`() {
        val (afterFire, reminder) = firedState()
        val (state, _) = ReminderLogic.snooze(afterFire, reminder, trigger)

        val (stillOpen, droppedOpen) = ReminderLogic.onSynced(state, snapshot())
        assertTrue(droppedOpen.isEmpty())
        assertEquals(setOf("rem-00001"), stillOpen.snoozed.keys)

        // de herinnering zelf is verwijderd, maar de taak staat nog open: de gebruiker vroeg om uitstel, dus die blijft
        val (reminderGone, droppedGone) = ReminderLogic.onSynced(state, snapshot(withReminder = false))
        assertTrue(droppedGone.isEmpty())
        assertEquals(setOf("rem-00001"), reminderGone.snoozed.keys)

        val (checked, droppedChecked) = ReminderLogic.onSynced(state, snapshot(checked = true))
        assertEquals(setOf("rem-00001"), droppedChecked)
        assertTrue(checked.snoozed.isEmpty())

        val (deleted, droppedDeleted) = ReminderLogic.onSynced(state, SyncSnapshot.EMPTY)
        assertEquals(setOf("rem-00001"), droppedDeleted)
        assertTrue(deleted.snoozed.isEmpty())
    }

    @Test
    fun `voltooien vanuit de melding haalt uitstel voor die taak weg`() {
        val (afterFire, reminder) = firedState()
        val (state, _) = ReminderLogic.snooze(afterFire, reminder, trigger)
        val (other, droppedOther) = ReminderLogic.onTaskCompleted(state, "task-9999")
        assertTrue(droppedOther.isEmpty())
        assertEquals(state, other)
        val (done, dropped) = ReminderLogic.onTaskCompleted(state, "task-0001")
        assertEquals(setOf("rem-00001"), dropped)
        assertTrue(done.snoozed.isEmpty())
    }

    @Test
    fun `afmelden wist alles, een nieuwe sessie van dezelfde gebruiker onthoudt wat getoond is`() {
        val (afterFire, reminder) = firedState()
        val (state, _) = ReminderLogic.snooze(afterFire, reminder, trigger)
        assertEquals(ReminderState(), ReminderLogic.cleared(state, keepShown = false))
        val kept = ReminderLogic.cleared(state, keepShown = true)
        assertEquals(state.shown, kept.shown)
        assertFalse(kept.shown.isEmpty())
        assertTrue(kept.snoozed.isEmpty())
        assertEquals(SyncSnapshot.EMPTY, kept.snapshot)
    }

    // ---------- voltooien dat nog naar de server moet ----------

    @Test
    fun `voltooien zonder verbinding wordt onthouden, een keer, tot het is afgehandeld`() {
        val (afterFire, reminder) = firedState()
        val queued = ReminderLogic.queueComplete(afterFire, reminder, trigger + minute)
        assertEquals(listOf(PendingComplete(reminder, trigger + minute)), queued.pendingCompletes.values.toList())

        // nog eens tikken op dezelfde melding: geen tweede verzoek, en het eerste tijdstip blijft staan
        assertEquals(queued, ReminderLogic.queueComplete(queued, reminder, trigger + 5 * minute))

        // plannen en verversen laten het staan
        val replanned = ReminderLogic.replan(queued, trigger + 2 * minute, amsterdam).state
        assertEquals(queued.pendingCompletes, replanned.pendingCompletes)
        assertEquals(queued.pendingCompletes, synced(replanned, snapshot()).pendingCompletes)

        // afgehandeld: weg; een onbekende afhandelen verandert niets
        assertEquals(queued, ReminderLogic.completeSettled(queued, "rem-99999"))
        assertTrue(ReminderLogic.completeSettled(queued, "rem-00001").pendingCompletes.isEmpty())

        // afmelden wist ook wat nog wachtte: het hoorde bij de vorige sessie
        assertTrue(ReminderLogic.cleared(queued, keepShown = true).pendingCompletes.isEmpty())
    }

    @Test
    fun `voltooien dat na drie dagen nog niet gelukt is, geven we op`() {
        val (afterFire, reminder) = firedState()
        val queuedAt = trigger + minute
        val queued = ReminderLogic.queueComplete(afterFire, reminder, queuedAt)
        assertTrue(ReminderLogic.expiredCompletes(queued, queuedAt + 2 * 24 * hour).isEmpty())
        assertTrue(ReminderLogic.expiredCompletes(queued, queuedAt + 3 * 24 * hour).isEmpty())
        assertEquals(listOf(PendingComplete(reminder, queuedAt)), ReminderLogic.expiredCompletes(queued, queuedAt + 3 * 24 * hour + 1))
    }

    @Test
    fun `het uuid voor voltooien blijft gelijk na uitstellen en na bewaren`() {
        val (afterFire, reminder) = firedState()
        val uuid = Ids.completeUuid(reminder.reminderId, reminder.taskId, reminder.triggerAtMs)

        // uitgesteld en tien minuten later opnieuw getoond: dezelfde herinnering, dus hetzelfde uuid
        val (snoozedState, _) = ReminderLogic.snooze(afterFire, reminder, trigger + minute)
        val again = ReminderLogic.replan(snoozedState, trigger + 11 * minute, amsterdam).snoozeFireNow.single().asPlanned()
        assertEquals(uuid, Ids.completeUuid(again.reminderId, again.taskId, again.triggerAtMs))

        // in de wachtrij gezet, bewaard en teruggelezen (de app is intussen gestopt): nog steeds hetzelfde uuid
        val restored = StateCodec.decode(StateCodec.encode(ReminderLogic.queueComplete(afterFire, reminder, trigger + minute)))
        val pending = restored.pendingCompletes.values.single().reminder
        assertEquals(uuid, Ids.completeUuid(pending.reminderId, pending.taskId, pending.triggerAtMs))
    }

    // ---------- bewaren ----------

    @Test
    fun `bewaren en teruglezen geeft dezelfde toestand`() {
        val (afterFire, reminder) = firedState()
        val (snoozedOnly, _) = ReminderLogic.snooze(afterFire, reminder, trigger)
        val snoozed = ReminderLogic.queueComplete(snoozedOnly, reminder, trigger + minute)
        val more = SyncSnapshot(
            tasks = snoozed.snapshot.tasks + TaskInfo("task-0002", "Met \"aanhalingstekens\", een\nregel en 😀", null, checked = true) + TaskInfo("task-0003", "Morgen", "2026-11-14T08:00"),
            reminders = snoozed.snapshot.reminders + ReminderInfo("rem-00002", "task-0002", "absolute", null, "2026-11-20T09:00") + ReminderInfo("rem-00003", "task-0003", "relative", 0, null),
        )
        val state = ReminderLogic.replan(snoozed.copy(snapshot = more), trigger + minute, amsterdam).state
        assertFalse(state.scheduled.isEmpty())
        assertFalse(state.snoozed.isEmpty())
        assertFalse(state.shown.isEmpty())
        assertFalse(state.pendingCompletes.isEmpty())

        assertEquals(state, StateCodec.decode(StateCodec.encode(state)))
        assertEquals(ReminderState(), StateCodec.decode(StateCodec.encode(ReminderState())))
    }

    @Test
    fun `onleesbare of beschadigde opslag geeft een lege toestand en geen fout`() {
        for (text in listOf(null, "", "onzin", "[]", "{}", "{\"v\":2}", "{\"v\":\"1\"}", "{\"v\":1")) {
            assertEquals("'$text'", ReminderState(), StateCodec.decode(text))
        }
        val partly = """
            {"v":1,
             "tasks":[{"id":"task-0001","content":"Goed","due":"2026-11-13T14:00","checked":false,"deleted":false}, {"content":"zonder id"}, 5, null],
             "reminders":[{"id":"rem-00001","task":"task-0001","type":"relative","offset":30,"due":null,"deleted":false}, {"id":"rem-00002"}, "x"],
             "scheduled":[{"id":"rem-00001","task":"task-0001","title":"Goed","at":1794573000000,"due":"2026-11-13T14:00"}, {"id":"rem-00009","task":"task-0001","title":"zonder tijdstip"}],
             "snoozed":"geen lijst",
             "shown":{"rem-00001@1794573000000":1794573000000,"kapot":"tekst"}}
        """.trimIndent()
        val state = StateCodec.decode(partly)
        assertEquals(listOf("task-0001"), state.snapshot.tasks.map { it.id })
        assertEquals(listOf("rem-00001"), state.snapshot.reminders.map { it.id })
        assertEquals(setOf("rem-00001"), state.scheduled.keys)
        assertTrue(state.snoozed.isEmpty())
        assertEquals(mapOf("rem-00001@1794573000000" to 1794573000000L), state.shown)
    }
}
