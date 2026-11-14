package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class GeoPolicyTest {
    @Test
    fun `dichtbij vaker kijken dan ver weg`() {
        val near = GeoPolicy.cadence(100.0)
        val mid = GeoPolicy.cadence(2_000.0)
        val far = GeoPolicy.cadence(50_000.0)
        assertTrue(near.minTimeMs < mid.minTimeMs && mid.minTimeMs < far.minTimeMs)
        assertTrue(near.minDistanceM < mid.minDistanceM && mid.minDistanceM < far.minDistanceM)
    }

    @Test
    fun `grenzen - nooit vaker dan elke minuut en nooit zeldzamer dan elke twintig minuten`() {
        val closest = GeoPolicy.cadence(0.0)
        assertEquals(GeoPolicy.MIN_INTERVAL_MS, closest.minTimeMs)
        assertEquals(GeoPolicy.MIN_DISTANCE_M.toFloat(), closest.minDistanceM, 0f)
        val farthest = GeoPolicy.cadence(10_000_000.0)
        assertEquals(GeoPolicy.MAX_INTERVAL_MS, farthest.minTimeMs)
        assertEquals(GeoPolicy.MAX_DISTANCE_M.toFloat(), farthest.minDistanceM, 0f)
    }

    @Test
    fun `de tijd past bij de snelheid waarmee de rand dichterbij kan komen`() {
        // 6000 m bij 20 m/s = 300 s = 5 minuten
        assertEquals(300_000L, GeoPolicy.cadence(6_000.0).minTimeMs)
        // 1200 m = 60 s, het minimum
        assertEquals(60_000L, GeoPolicy.cadence(1_200.0).minTimeMs)
    }

    @Test
    fun `zonder bekende positie gematigd vaak`() {
        val c = GeoPolicy.cadence(null)
        assertEquals(5L * 60 * 1000, c.minTimeMs)
        assertEquals(250f, c.minDistanceM, 0f)
    }

    @Test
    fun `de afstand in meters is op 25 afgerond`() {
        for (b in listOf(0.0, 77.0, 333.0, 999.0, 4_321.0, 99_999.0)) {
            val d = GeoPolicy.cadence(b).minDistanceM
            assertEquals("$b -> $d", 0f, d % 25f, 0f)
        }
    }

    @Test
    fun `zelf een positie vragen alleen als de laatste te oud is voor hoe dichtbij we zijn`() {
        val minute = 60_000L
        assertTrue("nog nooit een positie", GeoPolicy.needActiveFix(null, 500.0))
        assertTrue("geen afstand bekend", GeoPolicy.needActiveFix(5 * minute, null))
        assertFalse(GeoPolicy.needActiveFix(10 * minute, 500.0))
        assertTrue(GeoPolicy.needActiveFix(16 * minute, 500.0))
        assertFalse(GeoPolicy.needActiveFix(29 * minute, 3_000.0))
        assertTrue(GeoPolicy.needActiveFix(31 * minute, 3_000.0))
        assertFalse(GeoPolicy.needActiveFix(89 * minute, 20_000.0))
        assertTrue(GeoPolicy.needActiveFix(91 * minute, 20_000.0))
    }

    @Test
    fun `een gelijke aanvraag hoeft niet opnieuw`() {
        val a = GeoPolicy.cadence(500.0)
        assertTrue(GeoPolicy.sameCadence(a, GeoPolicy.cadence(500.0)))
        assertFalse(GeoPolicy.sameCadence(a, GeoPolicy.cadence(5_000.0)))
        assertFalse(GeoPolicy.sameCadence(null, a))
    }
}

class GeoRemindersTest {
    private val home = PlaceInfo("place-home-1", "Thuis", 52.0, 5.0, 150)
    private val work = PlaceInfo("place-work-1", "Werk", 52.1, 5.1, 200)
    private val tasks = listOf(
        TaskInfo("task-0001", "Pakket ophalen", "2026-11-13T14:00"),
        TaskInfo("task-0002", "Planten water geven", null),
        TaskInfo("task-0003", "Afgevinkt", null, checked = true),
        TaskInfo("task-0004", "Verwijderd", null, deleted = true),
    )

    private fun loc(id: String, task: String, place: String?, trigger: String?, deleted: Boolean = false) =
        ReminderInfo(id, task, "location", null, null, deleted, place, trigger)

    private fun snapshot(vararg reminders: ReminderInfo, places: List<PlaceInfo> = listOf(home, work)) =
        SyncSnapshot(tasks, reminders.toList(), places)

    private fun enter(place: PlaceInfo, at: Long = 1_000L) = GeoEvent(place.id, GeoKind.ENTER, at, 100.0)
    private fun leave(place: PlaceInfo, at: Long = 1_000L) = GeoEvent(place.id, GeoKind.LEAVE, at, 400.0)

    @Test
    fun `bij aankomst gaat alleen de aankomst-herinnering af, met de naam van de plaats`() {
        val s = snapshot(loc("rem-00001", "task-0001", home.id, "enter"), loc("rem-00002", "task-0002", home.id, "leave"))
        val due = GeoReminders.due(listOf(enter(home, 5_000L)), s)
        assertEquals(1, due.size)
        val p = due[0]
        assertEquals("rem-00001", p.reminderId)
        assertEquals("task-0001", p.taskId)
        assertEquals("Pakket ophalen", p.title)
        assertEquals(5_000L, p.triggerAtMs)
        assertEquals("Thuis", p.place)
        assertEquals("enter", p.trigger)
        assertEquals("2026-11-13T14:00", p.taskDue)
    }

    @Test
    fun `bij vertrek gaat alleen de vertrek-herinnering af`() {
        val s = snapshot(loc("rem-00001", "task-0001", home.id, "enter"), loc("rem-00002", "task-0002", home.id, "leave"))
        val due = GeoReminders.due(listOf(leave(home)), s)
        assertEquals(listOf("rem-00002"), due.map { it.reminderId })
        assertEquals("leave", due[0].trigger)
    }

    @Test
    fun `een andere plaats doet niets, meerdere herinneringen op een plaats gaan allemaal af`() {
        val s = snapshot(
            loc("rem-00001", "task-0001", home.id, "enter"),
            loc("rem-00002", "task-0002", home.id, "enter"),
            loc("rem-00003", "task-0002", work.id, "enter"),
        )
        assertEquals(listOf("rem-00001", "rem-00002"), GeoReminders.due(listOf(enter(home)), s).map { it.reminderId })
        assertEquals(listOf("rem-00003"), GeoReminders.due(listOf(enter(work)), s).map { it.reminderId })
    }

    @Test
    fun `niet voor een afgevinkte of verwijderde taak, en niet voor een verwijderde herinnering`() {
        val s = snapshot(
            loc("rem-00001", "task-0003", home.id, "enter"),
            loc("rem-00002", "task-0004", home.id, "enter"),
            loc("rem-00003", "task-0001", home.id, "enter", deleted = true),
            loc("rem-00004", "task-onbekend", home.id, "enter"),
        )
        assertTrue(GeoReminders.due(listOf(enter(home)), s).isEmpty())
        assertTrue(GeoReminders.active(s).isEmpty())
        assertTrue(GeoReminders.watchedPlaces(s).isEmpty())
    }

    @Test
    fun `niet zonder plaats of met een onbekende of verwijderde plaats`() {
        val s = snapshot(
            loc("rem-00001", "task-0001", null, "enter"),
            loc("rem-00002", "task-0001", "place-weg-1", "enter"),
            loc("rem-00003", "task-0001", home.id, "enter"),
            places = listOf(home.copy(deleted = true)),
        )
        assertTrue(GeoReminders.active(s).isEmpty())
        assertTrue(GeoReminders.due(listOf(enter(home)), s).isEmpty())
    }

    @Test
    fun `een onbekende of ontbrekende trigger doet niets`() {
        val s = snapshot(loc("rem-00001", "task-0001", home.id, null), loc("rem-00002", "task-0001", home.id, "binnen"), loc("rem-00003", "task-0001", home.id, "ENTER"))
        assertTrue(GeoReminders.active(s).isEmpty())
    }

    @Test
    fun `andere soorten herinneringen worden hier genegeerd`() {
        val s = snapshot(ReminderInfo("rem-00001", "task-0001", "relative", 30, null), ReminderInfo("rem-00002", "task-0001", "absolute", null, "2026-11-13T09:00"))
        assertTrue(GeoReminders.active(s).isEmpty())
    }

    @Test
    fun `een gebeurtenis geeft een herinnering hooguit een keer, ook bij dubbele gebeurtenissen`() {
        val s = snapshot(loc("rem-00001", "task-0001", home.id, "enter"))
        assertEquals(1, GeoReminders.due(listOf(enter(home, 1L), enter(home, 2L)), s).size)
    }

    @Test
    fun `zonder gebeurtenissen niets`() {
        assertTrue(GeoReminders.due(emptyList(), snapshot(loc("rem-00001", "task-0001", home.id, "enter"))).isEmpty())
    }

    @Test
    fun `alleen op plaatsen met een open herinnering wordt gelet`() {
        val s = snapshot(loc("rem-00001", "task-0001", home.id, "leave"), loc("rem-00002", "task-0003", work.id, "enter"))
        assertEquals(listOf(home.id), GeoReminders.watchedPlaces(s).map { it.id })
    }

    @Test
    fun `een plaats met twee herinneringen komt een keer voor`() {
        val s = snapshot(loc("rem-00001", "task-0001", home.id, "leave"), loc("rem-00002", "task-0002", home.id, "enter"))
        assertEquals(1, GeoReminders.watchedPlaces(s).size)
    }

    @Test
    fun `de herinnering in de lijst met te plannen tijdherinneringen komt niet voor - de planner kent haar niet`() {
        val reminders = listOf(loc("rem-00001", "task-0001", home.id, "enter"))
        assertNull(Planner.triggerTime(reminders[0], tasks[0], java.time.ZoneId.of("Europe/Amsterdam")))
        assertTrue(Planner.plan(tasks, reminders, 0L, java.time.ZoneId.of("Europe/Amsterdam")).isEmpty())
    }
}

class GeoStateCodecTest {
    @Test
    fun `een toestand heen en terug`() {
        val state = GeoState(
            tracks = mapOf(
                "p1" to PlaceTrack(true, 1_000, null, "52.0|5.0|150"),
                "p2" to PlaceTrack(false, 2_000, 1_500, "52.5|5.5|300"),
            ),
            lastFix = Fix(52.123456, 5.654321, 17.5f, 123_456_789L),
            lastCheckMs = 123_457_000L,
            lastIgnored = Ignored.JUMP,
        )
        assertEquals(state, GeoStateCodec.decode(GeoStateCodec.encode(state)))
        assertEquals(GeoState(), GeoStateCodec.decode(GeoStateCodec.encode(GeoState())))
    }

    @Test
    fun `onleesbaar of van een andere versie geeft een lege toestand`() {
        for (text in listOf(null, "", "geen json", "[]", "{}", "{\"v\":2}", "{\"v\":\"1\"}")) {
            assertEquals(text.toString(), GeoState(), GeoStateCodec.decode(text))
        }
    }

    @Test
    fun `kapotte onderdelen worden overgeslagen, de rest blijft`() {
        val text = "{\"v\":1,\"tracks\":[{\"id\":\"p1\",\"inside\":true,\"checked\":5,\"sig\":\"s\"},{\"id\":\"bad id!\",\"inside\":true,\"checked\":5,\"sig\":\"s\"},{\"id\":\"p3\"},5]," +
            "\"fix\":{\"lat\":95,\"lon\":0,\"at\":5},\"check\":7,\"ignored\":\"ONBEKEND\"}"
        val state = GeoStateCodec.decode(text)
        assertEquals(setOf("p1"), state.tracks.keys)
        assertNull("een positie die niet bestaat", state.lastFix)
        assertEquals(7L, state.lastCheckMs)
        assertNull(state.lastIgnored)
    }
}
