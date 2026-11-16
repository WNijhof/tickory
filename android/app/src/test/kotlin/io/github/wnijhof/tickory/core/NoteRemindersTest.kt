package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.FakeServer.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime

/** Herinneringen op notities: dezelfde rekenregels als shared/notes.js op de server, en hoe de app ze plant en opent. */
class NoteRemindersTest {
    private fun t(s: String): LocalDateTime = NoteReminders.parse(s)!!
    private fun upcoming(at: String?, repeat: String?, from: String) = NoteReminders.upcoming(at, repeat, t(from)).map(NoteReminders::format)

    @Test
    fun `alleen een bestaande datum met tijd`() {
        assertEquals("2026-11-16T09:30", NoteReminders.format(t("2026-11-16T09:30")))
        for (bad in listOf("2026-02-30T09:00", "2026-11-16", "2026-11-16T25:00", "2026-11-16T09:30:00", "morgen", null)) {
            assertNull(bad, NoteReminders.parse(bad))
        }
    }

    @Test
    fun `herhalen zoals de server - de 31e wordt de laatste dag, 29 februari in een gewoon jaar 28 februari`() {
        assertEquals("2026-02-28T09:00", NoteReminders.format(NoteReminders.at(t("2026-01-31T09:00"), "monthly", 1)))
        assertEquals("2026-03-31T09:00", NoteReminders.format(NoteReminders.at(t("2026-01-31T09:00"), "monthly", 2)))
        assertEquals("2029-02-28T08:00", NoteReminders.format(NoteReminders.at(t("2028-02-29T08:00"), "yearly", 1)))
        assertEquals("2032-02-29T08:00", NoteReminders.format(NoteReminders.at(t("2028-02-29T08:00"), "yearly", 4)))
        assertEquals("2027-01-04T09:00", NoteReminders.format(NoteReminders.at(t("2026-12-28T09:00"), "weekly", 1)))
    }

    @Test
    fun `de komende keren - eenmalig voorbij geeft niets, een herhaling hooguit tien binnen zestig dagen`() {
        assertEquals(listOf("2026-11-16T09:00"), upcoming("2026-11-16T09:00", null, "2026-11-16T08:00"))
        assertEquals(emptyList<String>(), upcoming("2026-11-16T09:00", null, "2026-11-16T09:01"))
        assertEquals("verder dan zestig dagen: later", emptyList<String>(), upcoming("2027-03-01T09:00", null, "2026-11-16T09:00"))
        val daily = upcoming("2026-01-01T07:30", "daily", "2026-11-16T08:00")
        assertEquals(10, daily.size)
        assertEquals("2026-11-17T07:30", daily.first())
        val weekly = upcoming("2020-01-06T09:00", "weekly", "2026-11-18T10:00")
        assertEquals("maandagen sinds 2020", listOf("2026-11-23T09:00", "2026-11-30T09:00"), weekly.take(2))
        assertEquals("acht maandagen in zestig dagen", 8, weekly.size)
        assertEquals(listOf("2026-11-30T09:00", "2026-12-31T09:00"), upcoming("2026-01-31T09:00", "monthly", "2026-11-16T00:00"))
        assertEquals(emptyList<String>(), upcoming("kapot", "daily", "2026-11-16T00:00"))
        assertEquals("een onbekende herhaling telt als eenmalig", listOf("2026-11-20T09:00"), upcoming("2026-11-20T09:00", "hourly", "2026-11-16T00:00"))
    }

    @Test
    fun `de kop van de melding - de titel, anders de eerste regel zonder opmaaktekens`() {
        assertEquals("Plan", NoteReminders.headline("  Plan ", "x"))
        assertEquals("melk halen", NoteReminders.headline("", "\n- [ ] **melk** halen\nmeer"))
        assertEquals("Let op link", NoteReminders.headline(null, "## =={green}Let op== [link](https://x.nl)"))
        assertEquals("", NoteReminders.headline(null, null))
    }

    @Test
    fun `uit het antwoord van de server - een taak per notitie en een herinnering per keer, met vaste ids`() {
        val body = """
            {"tasks": [], "reminders": [], "notes": [
              {"id": "note-aaaa-0001", "title": "", "content": "- [ ] **melk** halen", "remind_at": "2026-11-16T18:00", "remind_repeat": null, "trashed_at": null, "is_deleted": false},
              {"id": "note-aaaa-0002", "title": "Planten", "content": "", "remind_at": "2026-11-01T09:00", "remind_repeat": "weekly", "trashed_at": null, "is_deleted": false},
              {"id": "note-aaaa-0003", "title": "Weg", "remind_at": "2026-11-16T18:00", "trashed_at": "2026-11-15T10:00:00.000Z", "is_deleted": false},
              {"id": "note-aaaa-0004", "title": "Voorbij", "remind_at": "2026-11-10T18:00", "remind_repeat": null, "is_deleted": false},
              {"id": "note-aaaa-0005", "title": "Zonder", "remind_at": null, "is_deleted": false},
              {"id": "note aaaa 0006", "title": "Raar id", "remind_at": "2026-11-16T18:00", "is_deleted": false},
              {"id": "note-aaaa-0007", "title": "Gewist", "remind_at": "2026-11-16T18:00", "is_deleted": true}
            ]}
        """.trimIndent()
        val snapshot = SyncParser.parseSnapshot(body, t("2026-11-16T12:00"))!!
        assertEquals(listOf("note_note-aaaa-0001", "note_note-aaaa-0002"), snapshot.tasks.map { it.id })
        assertEquals("melk halen", snapshot.tasks[0].content)
        assertNull(snapshot.tasks[0].due)
        val first = snapshot.reminders.first()
        assertEquals(ReminderInfo("note_note-aaaa-0001_202611161800", "note_note-aaaa-0001", "absolute", null, "2026-11-16T18:00"), first)
        val weekly = snapshot.reminders.filter { it.taskId == "note_note-aaaa-0002" }.map { it.due }
        assertEquals(listOf("2026-11-22T09:00", "2026-11-29T09:00"), weekly.take(2))
        assertTrue(snapshot.reminders.all { Ids.isSafeId(it.id) && Ids.isSafeId(it.taskId) })
        // en de planner maakt er gewone meldingen van
        val zone = java.time.ZoneId.of("Europe/Amsterdam")
        val now = t("2026-11-16T12:00").atZone(zone).toInstant().toEpochMilli()
        val planned = Planner.plan(snapshot.tasks, snapshot.reminders, now, zone)
        assertEquals("melk halen", planned.first().title)
        assertEquals(t("2026-11-16T18:00").atZone(zone).toInstant().toEpochMilli(), planned.first().triggerAtMs)
    }

    @Test
    fun `een notitie die iemand met je deelde - de herinnering is van de eigenaar en gaat hier niet af`() {
        val body = """{"me": {"id": "user-anna"}, "tasks": [], "reminders": [], "notes": [
            {"id": "note-eigen-001", "owner_id": "user-anna", "title": "Mijn", "remind_at": "2026-11-16T18:00", "is_deleted": false},
            {"id": "note-bram-0001", "owner_id": "user-bram", "title": "Van Bram", "remind_at": "2026-11-16T18:00", "is_deleted": false}
        ]}"""
        assertEquals(listOf("note_note-eigen-001"), SyncParser.parseSnapshot(body, t("2026-11-16T12:00"))!!.tasks.map { it.id })
    }

    @Test
    fun `een herinnering die net gemist is (toestel uit) komt nog, tot een uur te laat`() {
        val body = """{"tasks": [], "reminders": [], "notes": [{"id": "note-bbbb-0001", "title": "Bellen", "remind_at": "2026-11-16T11:30", "is_deleted": false}]}"""
        assertEquals(1, SyncParser.parseSnapshot(body, t("2026-11-16T12:00"))!!.reminders.size)
        assertEquals(0, SyncParser.parseSnapshot(body, t("2026-11-16T12:31"))!!.reminders.size)
    }

    @Test
    fun `een server zonder notities - het antwoord heeft geen notes en blijft gewoon bruikbaar`() {
        val snapshot = SyncParser.parseSnapshot("""{"tasks": [], "reminders": []}""")!!
        assertTrue(snapshot.tasks.isEmpty() && snapshot.reminders.isEmpty())
    }

    @Test
    fun `een tik op de melding opent de notitie, niet een taak`() {
        assertEquals("note=note-aaaa-0001", DeepLink.task("note_note-aaaa-0001"))
        assertEquals("task=task-0001", DeepLink.task("task-0001"))
        assertEquals("note=note-aaaa-0001", DeepLink.fromExtras("note_note-aaaa-0001", false, null))
        assertTrue(DeepLink.isSafe(DeepLink.task("note_note-aaaa-0001")))
        assertTrue(NoteReminders.isNote("note_x"))
        assertFalse(NoteReminders.isNote("task-0001"))
        assertFalse(NoteReminders.isNote(null))
    }

    @Test
    fun `ophalen - een server zonder notities weigert notes, dan hetzelfde zonder, en de rest blijft`() {
        FakeServer { request ->
            val types = Json.parseObject(request.body)!!.list("resource_types")!!
            if (types.contains("notes")) Response(400, """{"error_code":"INVALID_REQUEST","error":"onbekend resourcetype \"notes\""}""")
            else Response(200, """{"sync_token":"9","me":{"id":"user-anna"},"tasks":[],"reminders":[],"projects":[],"places":[],"notifications":[]}""")
        }.use { server ->
            val result = ApiClient(server.origin, 5_000, 5_000).fetchSnapshot("tky_test")
            assertTrue("$result", result is FetchResult.Ok)
            assertEquals(2, server.requests.size)
            val second = Json.parseObject(server.requests[1].body)!!.list("resource_types")!!
            assertTrue(second.containsAll(listOf("places", "notifications", "settings", "comments")))
            assertFalse(second.contains("notes"))
        }
    }
}
