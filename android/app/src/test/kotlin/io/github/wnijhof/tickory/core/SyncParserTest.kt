package io.github.wnijhof.tickory.core

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncParserTest {
    /** Een antwoord zoals de server het stuurt: met alle velden, ook die we niet gebruiken. */
    private val realistic = """
        {
          "sync_token": "42", "full_sync": true, "partial": true, "sync_status": {},
          "me": {"id": "user-anna-0001", "username": "anna", "name": "Anna", "is_admin": true},
          "users": [{"id": "user-anna-0001", "username": "anna", "name": "Anna"}],
          "tasks": [
            {"id": "task-0001", "project_id": "inbox-project", "section_id": null, "parent_id": null, "content": "Tandarts bellen",
             "description": "", "priority": 4, "labels": [], "due": {"date": "2026-11-13T14:00", "string": "vandaag 14:00", "lang": "nl"},
             "deadline": null, "duration": null, "assignee_id": null, "creator_id": "user-anna-0001", "checked": false,
             "completed_at": null, "completed_count": 0, "is_collapsed": false, "order_key": "a0", "is_deleted": false,
             "created_at": "2026-11-13T08:00:00.000Z", "updated_at": "2026-11-13T08:00:00.000Z"},
            {"id": "task-0002", "project_id": "inbox-project", "content": "Boodschappen", "due": {"date": "2026-11-14"}, "checked": false, "is_deleted": false},
            {"id": "task-0003", "project_id": "inbox-project", "content": "Klaar", "due": null, "checked": true, "is_deleted": false}
          ],
          "reminders": [
            {"id": "rem-00001", "task_id": "task-0001", "type": "relative", "minute_offset": 30, "due": null, "owner_id": "user-anna-0001", "is_deleted": false},
            {"id": "rem-00002", "task_id": "task-0002", "type": "absolute", "minute_offset": null, "due": {"date": "2026-11-14T09:00"}, "owner_id": "user-anna-0001", "is_deleted": false}
          ]
        }
    """.trimIndent()

    @Test
    fun `een gewoon antwoord van de server`() {
        val snapshot = SyncParser.parseSnapshot(realistic)!!
        assertEquals(
            listOf(
                TaskInfo("task-0001", "Tandarts bellen", "2026-11-13T14:00", checked = false, deleted = false),
                TaskInfo("task-0002", "Boodschappen", "2026-11-14", checked = false, deleted = false),
                TaskInfo("task-0003", "Klaar", null, checked = true, deleted = false),
            ),
            snapshot.tasks,
        )
        assertEquals(
            listOf(
                ReminderInfo("rem-00001", "task-0001", "relative", 30, null, deleted = false),
                ReminderInfo("rem-00002", "task-0002", "absolute", null, "2026-11-14T09:00", deleted = false),
            ),
            snapshot.reminders,
        )
        assertEquals(setOf("task-0001", "task-0002"), snapshot.activeTaskIds())
    }

    @Test
    fun `onbruikbaar antwoord geeft null en gooit niet`() {
        val unusable = listOf(
            null, "", " ", "geen json", "<html>502 Bad Gateway</html>", "[]", "null", "42", "\"tekst\"", "{", "{}",
            """{"tasks":[]}""", // herinneringen ontbreken
            """{"reminders":[]}""", // taken ontbreken
            """{"tasks":null,"reminders":[]}""",
            """{"tasks":{},"reminders":[]}""",
            """{"tasks":[],"reminders":"geen"}""",
            """{"tasks":[],"reminders":[]""", // afgekapt
            """{"error_code":"UNAUTHORIZED","error":"ongeldige of ontbrekende aanmelding"}""",
        )
        for (body in unusable) assertNull("'$body'", SyncParser.parseSnapshot(body))
    }

    @Test
    fun `lege lijsten zijn een geldig antwoord`() {
        val snapshot = SyncParser.parseSnapshot("""{"tasks":[],"reminders":[]}""")
        assertNotNull(snapshot)
        assertTrue(snapshot!!.tasks.isEmpty())
        assertTrue(snapshot.reminders.isEmpty())
    }

    @Test
    fun `kapotte taken worden overgeslagen, de rest blijft`() {
        val body = """
            {"reminders": [], "tasks": [
              null, 7, "tekst", [], {},
              {"content": "zonder id"},
              {"id": 12345678, "content": "id is een getal"},
              {"id": "", "content": "leeg id"},
              {"id": "../../etc", "content": "raar id"},
              {"id": "met spatie", "content": "raar id"},
              {"id": "task-ok-01"},
              {"id": "task-ok-02", "content": 99, "due": "2026-11-13", "checked": "ja", "is_deleted": null},
              {"id": "task-ok-03", "content": null, "due": {"date": 20261113}, "checked": 1, "is_deleted": 0},
              {"id": "task-ok-04", "content": "  veel   witruimte\n\ten regels ", "due": {"geen": "datum"}, "checked": true, "is_deleted": true},
              {"id": "task-ok-05", "content": "extra velden", "onbekend": {"diep": [1, 2, {"x": null}]}, "due": {"date": "2026-11-13T14:00", "recurrence": {"freq": "daily"}}}
            ]}
        """.trimIndent()
        val tasks = SyncParser.parseSnapshot(body)!!.tasks
        assertEquals(listOf("task-ok-01", "task-ok-02", "task-ok-03", "task-ok-04", "task-ok-05"), tasks.map { it.id })
        assertEquals(TaskInfo("task-ok-01", "", null, checked = false, deleted = false), tasks[0])
        assertEquals(TaskInfo("task-ok-02", "", null, checked = false, deleted = false), tasks[1])
        assertEquals(TaskInfo("task-ok-03", "", null, checked = true, deleted = false), tasks[2])
        assertEquals(TaskInfo("task-ok-04", "veel witruimte en regels", null, checked = true, deleted = true), tasks[3])
        assertEquals("2026-11-13T14:00", tasks[4].due)
    }

    @Test
    fun `kapotte herinneringen worden overgeslagen, de rest blijft`() {
        val body = """
            {"tasks": [], "reminders": [
              null, 3, {}, [],
              {"task_id": "task-0001", "type": "relative", "minute_offset": 30},
              {"id": "rem-zonder-taak", "type": "relative", "minute_offset": 30},
              {"id": "rem-taak-getal", "task_id": 5, "type": "relative", "minute_offset": 30},
              {"id": "rem-zonder-soort", "task_id": "task-0001", "minute_offset": 30},
              {"id": "rem-ok-001", "task_id": "task-0001", "type": "relative", "minute_offset": 30.0},
              {"id": "rem-ok-002", "task_id": "task-0001", "type": "relative", "minute_offset": "30"},
              {"id": "rem-ok-003", "task_id": "task-0001", "type": "relative", "minute_offset": 30.5},
              {"id": "rem-ok-004", "task_id": "task-0001", "type": "absolute", "due": "2026-11-13T14:00"},
              {"id": "rem-ok-005", "task_id": "task-0001", "type": "absolute", "due": {"date": "2026-11-13T14:00"}, "is_deleted": true},
              {"id": "rem-ok-006", "task_id": "task-0001", "type": "iets-nieuws", "due": {"date": null}}
            ]}
        """.trimIndent()
        val reminders = SyncParser.parseSnapshot(body)!!.reminders
        assertEquals(listOf("rem-ok-001", "rem-ok-002", "rem-ok-003", "rem-ok-004", "rem-ok-005", "rem-ok-006"), reminders.map { it.id })
        assertEquals(30L, reminders[0].minuteOffset)
        assertNull("tekst is geen getal", reminders[1].minuteOffset)
        assertNull("een half is geen heel aantal minuten", reminders[2].minuteOffset)
        assertNull("due moet een object zijn", reminders[3].due)
        assertEquals("2026-11-13T14:00", reminders[4].due)
        assertTrue(reminders[4].deleted)
        assertEquals("iets-nieuws", reminders[5].type)
        assertNull(reminders[5].due)
    }

    @Test
    fun `wat de lezer doorlaat, breekt de planner niet`() {
        // Alle rare maar leesbare gevallen hierboven samen door de planner: geen fout, en alleen het geldige komt eruit.
        val body = """
            {"tasks": [
              {"id": "task-0001", "content": "Goed", "due": {"date": "2026-11-13T14:00"}},
              {"id": "task-0002", "content": "Datum is onzin", "due": {"date": "volgende week"}},
              {"id": "task-0003", "due": {"date": "2026-11-13T14:00"}, "checked": true}
            ], "reminders": [
              {"id": "rem-00001", "task_id": "task-0001", "type": "relative", "minute_offset": 30},
              {"id": "rem-00002", "task_id": "task-0001", "type": "relative", "minute_offset": "30"},
              {"id": "rem-00003", "task_id": "task-0002", "type": "relative", "minute_offset": 10},
              {"id": "rem-00004", "task_id": "task-0003", "type": "relative", "minute_offset": 10},
              {"id": "rem-00005", "task_id": "task-9999", "type": "relative", "minute_offset": 10},
              {"id": "rem-00006", "task_id": "task-0001", "type": "absolute", "due": {"date": "2026-11-13"}},
              {"id": "rem-00007", "task_id": "task-0001", "type": "iets-nieuws"}
            ]}
        """.trimIndent()
        val snapshot = SyncParser.parseSnapshot(body)!!
        val now = java.time.Instant.parse("2026-11-13T09:00:00Z").toEpochMilli()
        val plan = Planner.plan(snapshot.tasks, snapshot.reminders, now, java.time.ZoneId.of("Europe/Amsterdam"))
        assertEquals(listOf("rem-00001"), plan.map { it.reminderId })
    }

    @Test
    fun `alleen bewaren wat nodig is om te plannen`() {
        val snapshot = SyncSnapshot(
            tasks = listOf(
                TaskInfo("task-0001", "met herinnering", "2026-11-13T14:00"),
                TaskInfo("task-0002", "zonder herinnering", "2026-11-13T15:00"),
                TaskInfo("task-0003", "herinnering is verwijderd", "2026-11-13T16:00"),
                TaskInfo("task-0004", "afgevinkt met herinnering", "2026-11-13T17:00", checked = true),
                TaskInfo("task-0005", "verwijderd met herinnering", "2026-11-13T18:00", deleted = true),
            ),
            reminders = listOf(
                ReminderInfo("rem-00001", "task-0001", "relative", 10, null),
                ReminderInfo("rem-00003", "task-0003", "relative", 10, null, deleted = true),
                ReminderInfo("rem-00004", "task-0004", "relative", 10, null),
                ReminderInfo("rem-00005", "task-0005", "relative", 10, null),
            ),
        )
        val trimmed = snapshot.trimmed()
        assertEquals(listOf("task-0001", "task-0004"), trimmed.tasks.map { it.id })
        assertEquals(listOf("rem-00001", "rem-00004", "rem-00005"), trimmed.reminders.map { it.id })
        assertEquals(setOf("task-0001", "task-0002", "task-0003"), snapshot.activeTaskIds())
    }

    // ---------- uitkomst van een commando ----------

    @Test
    fun `uitkomst van een commando`() {
        val uuid = "tickory-done-0123456789abcdef"
        assertEquals(CommandStatus.Ok, SyncParser.commandStatus("""{"sync_status":{"$uuid":"ok"},"tasks":[]}""", uuid))

        val rejected = SyncParser.commandStatus("""{"sync_status":{"$uuid":{"error_code":"NOT_FOUND","error":"task.id bestaat niet"}}}""", uuid)
        assertEquals(CommandStatus.Rejected("NOT_FOUND", "task.id bestaat niet"), rejected)

        // foutobject zonder de bekende velden: nog steeds een weigering
        assertEquals(CommandStatus.Rejected("UNKNOWN", ""), SyncParser.commandStatus("""{"sync_status":{"$uuid":{}}}""", uuid))
        assertEquals(CommandStatus.Rejected("UNKNOWN", ""), SyncParser.commandStatus("""{"sync_status":{"$uuid":{"error_code":5,"error":null}}}""", uuid))
    }

    @Test
    fun `uitkomst van een commando ontbreekt of is onleesbaar`() {
        val uuid = "tickory-done-0123456789abcdef"
        val missing = listOf(
            null, "", "geen json", "[]", "{}", """{"sync_status":null}""", """{"sync_status":[]}""", """{"sync_status":{}}""",
            """{"sync_status":{"ander-uuid-12345":"ok"}}""", """{"sync_status":{"$uuid":"OK"}}""", """{"sync_status":{"$uuid":true}}""",
            """{"sync_status":{"$uuid":null}}""", """{"sync_status":{"$uuid":1}}""", """{"sync_status":{"$uuid":["ok"]}}""",
        )
        for (body in missing) assertEquals("'$body'", CommandStatus.Missing, SyncParser.commandStatus(body, uuid))
    }

    // ---------- titel ----------

    @Test
    fun `titel wordt een regel van hooguit tweehonderd tekens`() {
        assertEquals("", SyncParser.cleanTitle(null))
        assertEquals("", SyncParser.cleanTitle("   \n\t "))
        assertEquals("Bellen met de tandarts", SyncParser.cleanTitle("  Bellen\nmet   de\ttandarts "))

        val long = SyncParser.cleanTitle("x".repeat(500))
        assertEquals(200, long.length)
        assertTrue(long.endsWith("…"))
        assertEquals("x".repeat(200), SyncParser.cleanTitle("x".repeat(200)))

        // een emoji (twee tekens in het geheugen) precies op de knip wordt niet doormidden gezaagd
        val emoji = SyncParser.cleanTitle("y".repeat(198) + "😀" + "z".repeat(50))
        assertFalse(emoji.any { it.isSurrogate() })
        assertTrue(emoji.endsWith("…"))
    }
}
