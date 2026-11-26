package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

/** De regels van het kleine venster zonder Android: de wachtrij, de verzoeken, het lezen van het antwoord en de keuzelijst. */
class QuickAddTest {
    private fun item(
        uuid: String = "tickory-q-000000000000000000000001",
        text: String = "Brood halen morgen",
        project: String? = null,
        due: String? = null,
        priority: Int? = null,
        account: String? = "user-anna-0001",
        session: String = "0123456789abcdef",
        at: Long = 1_000_000L,
    ) = QueuedQuickAdd(uuid, text, project, due, priority, "2026-11-13T23:30+01:00", "Europe/Amsterdam", account, session, at)

    @Test
    fun `uuid - het afgesproken formaat, en elke keer een ander`() {
        val a = QuickAddQueue.newUuid()
        assertTrue(a, Regex("^tickory-q-[0-9a-f]{24}$").matches(a))
        assertNotEquals(a, QuickAddQueue.newUuid())
        var n = 0
        assertEquals("tickory-q-000102030405060708090a0b", QuickAddQueue.newUuid { n++ })
    }

    @Test
    fun `geplakte lijst - regels zonder lege regels en opsommingstekens, zoals in de web-app`() {
        assertEquals(
            listOf("Eieren kopen", "Brood p1", "Kaas", "Melk", "Thee", "Koffie", "Suiker", "2026 wordt een goed jaar"),
            QuickAddQueue.splitPastedLines("- Eieren kopen\r\n* Brood p1\n\n  + Kaas  \n• Melk\n- [ ] Thee\n- [x] Koffie\n1. Suiker\r2026 wordt een goed jaar"),
        )
        assertEquals("één regel blijft één taak", listOf("Brood halen"), QuickAddQueue.splitPastedLines("Brood halen"))
        assertEquals(emptyList<String>(), QuickAddQueue.splitPastedLines("\n  \n- \n"))
        assertEquals("hooguit 100", 100, QuickAddQueue.splitPastedLines((1..150).joinToString("\n") { "Taak $it" }).size)
        assertEquals("elke regel hooguit de lengte die de server aanneemt", QuickAddQueue.MAX_TEXT, QuickAddQueue.splitPastedLines("a\n" + "b".repeat(5000))[1].length)
    }

    @Test
    fun `geplakte lijst - allemaal in de wachtrij, of geen als die te vol is`() {
        fun uuid(i: Int) = "tickory-q-" + i.toString().padStart(24, '0')
        val three = (1..3).map { item(uuid = uuid(it), text = "Taak $it") }
        val (queued, ok) = QuickAddQueue.enqueueAll(emptyList(), three)
        assertTrue(ok)
        assertEquals(three, queued)
        assertFalse("een uuid dat er al staat: niets erbij", QuickAddQueue.enqueueAll(queued, listOf(item(uuid = uuid(9)), item(uuid = uuid(1)))).second)
        val almostFull = (100..(99 + QuickAddQueue.MAX_ITEMS - 2)).map { item(uuid = uuid(it)) }
        val (same, full) = QuickAddQueue.enqueueAll(almostFull, three)
        assertFalse("past niet helemaal: geen enkele erbij", full)
        assertEquals(almostFull, same)
        assertFalse(QuickAddQueue.enqueueAll(emptyList(), emptyList()).second)
    }

    @Test
    fun `de vingerafdruk van de aanmelding - vast per token, anders per token, en niet het token zelf`() {
        val a = QuickAddQueue.sessionTag("tky_geheim-1")
        assertTrue(Regex("^[0-9a-f]{16}$").matches(a))
        assertEquals(a, QuickAddQueue.sessionTag("tky_geheim-1"))
        assertNotEquals(a, QuickAddQueue.sessionTag("tky_geheim-2"))
        assertFalse(a.contains("geheim"))
    }

    @Test
    fun `de rij - hetzelfde uuid niet twee keer, en niet meer dan het maximum`() {
        val (one, added) = QuickAddQueue.enqueue(emptyList(), item())
        assertTrue(added)
        val (same, again) = QuickAddQueue.enqueue(one, item(text = "anders"))
        assertFalse(again)
        assertEquals(one, same)
        val full = (1..QuickAddQueue.MAX_ITEMS).map { item(uuid = "tickory-q-${it.toString().padStart(24, '0')}") }
        assertFalse(QuickAddQueue.enqueue(full, item(uuid = "tickory-q-nieuw-0000000000000000")).second)
        assertTrue(QuickAddQueue.enqueue(full.drop(1), item(uuid = "tickory-q-nieuw-0000000000000000")).second)
    }

    @Test
    fun `de rij - afhandelen en vervallen na veertien dagen`() {
        val now = 100L * 24 * 60 * 60 * 1000
        val old = item(uuid = "tickory-q-oud-000000000000000000", at = now - QuickAddQueue.RETENTION_MS - 1)
        val edge = item(uuid = "tickory-q-rand-00000000000000000", at = now - QuickAddQueue.RETENTION_MS)
        val fresh = item(uuid = "tickory-q-vers-00000000000000000", at = now)
        assertEquals(listOf(old), QuickAddQueue.expired(listOf(old, edge, fresh), now))
        assertEquals(listOf(fresh), QuickAddQueue.settle(listOf(old, edge, fresh), setOf(old.uuid, edge.uuid)))
    }

    @Test
    fun `van wie - alleen wat van deze gebruiker is, of zonder gebruiker van deze aanmelding`() {
        val anna = item(uuid = "tickory-q-anna-00000000000000000", account = "user-anna-0001")
        val bram = item(uuid = "tickory-q-bram-00000000000000000", account = "user-bram-0002")
        val loose = item(uuid = "tickory-q-los1-00000000000000000", account = null, session = "aaaaaaaaaaaaaaaa")
        val other = item(uuid = "tickory-q-los2-00000000000000000", account = null, session = "bbbbbbbbbbbbbbbb")
        val all = listOf(anna, bram, loose, other)
        assertEquals(listOf(anna, loose), QuickAddQueue.sendable(all, "user-anna-0001", "aaaaaaaaaaaaaaaa"))
        assertEquals(listOf(bram, other), QuickAddQueue.foreign(all, "user-anna-0001", "aaaaaaaaaaaaaaaa"))
        // gebruiker nog onbekend: alleen wat zonder gebruiker bij deze aanmelding hoort, en niets is "van een ander"
        assertEquals(listOf(loose), QuickAddQueue.sendable(all, null, "aaaaaaaaaaaaaaaa"))
        assertEquals(emptyList<QueuedQuickAdd>(), QuickAddQueue.foreign(all, null, "aaaaaaaaaaaaaaaa"))
        assertEquals(emptyList<QueuedQuickAdd>(), QuickAddQueue.sendable(all, null, null))
    }

    @Test
    fun `het verzoek - alleen wat er is, in de vorm van de server`() {
        assertEquals(
            """{"text":"Brood halen morgen","uuid":"tickory-q-000000000000000000000001","typed_at":"2026-11-13T23:30+01:00","tz":"Europe/Amsterdam"}""",
            QuickAddQueue.requestBody(item()),
        )
        val full = Json.parseObject(QuickAddQueue.requestBody(item(project = "project-werk-001", due = "tomorrow", priority = 2)))!!
        assertEquals("project-werk-001", full.text("project_id"))
        assertEquals("tomorrow", full.text("due"))
        assertEquals(2L, full.whole("priority"))
        assertNull(full["dry_run"])
        assertNull("geen account of vingerafdruk naar de server", full["account"] ?: full["session"])
        val dry = Json.parseObject(QuickAddQueue.previewBody("Iets \"geks\" \n", null, "today", null, "2026-11-13T09:00+01:00", "Europe/Amsterdam"))!!
        assertEquals(true, dry["dry_run"])
        assertEquals("Iets \"geks\" \n", dry.text("text"))
        assertNull(dry["uuid"])
        assertNull(dry["project_id"])
        assertNull("zonder taal geen lang", dry["lang"])
        // de taal van de telefoon gaat mee, zodat de server datums in die taal leest
        assertEquals("en", Json.parseObject(QuickAddQueue.requestBody(item(), "en"))!!.text("lang"))
        assertEquals("nl", Json.parseObject(QuickAddQueue.previewBody("Brood morgen", null, null, null, "2026-11-13T09:00+01:00", "Europe/Amsterdam", "nl"))!!.text("lang"))
    }

    @Test
    fun `bewaren en teruglezen, en een kapot bestand of een vreemde regel valt weg`() {
        val items = listOf(item(), item(uuid = "tickory-q-twee-00000000000000000", project = "project-1", due = "today", priority = 1, account = null))
        assertEquals(items, QuickAddQueue.decode(QuickAddQueue.encode(items)))
        for (bad in listOf(null, "", "{", "[]", """{"v":2,"items":[]}""", """{"v":1}""")) assertEquals(emptyList<QueuedQuickAdd>(), QuickAddQueue.decode(bad))
        val good = """{"uuid":"tickory-q-goed-0000000000000000","text":"Goed","typedAt":"2026-11-13T23:30+01:00","tz":"Europe/Amsterdam","session":"0123456789abcdef","at":5}"""
        val broken = listOf(
            good.replace("\"Goed\"", "\"  \""),
            good.replace("tickory-q-goed-0000000000000000", "kort"),
            good.replace("\"at\":5", "\"at\":\"vijf\""),
            good.replace("2026-11-13T23:30+01:00", "morgen"),
            good.replace("Europe/Amsterdam", "Europe/Am sterdam"),
            good.replace("0123456789abcdef", "token"),
            good.replace("}", ",\"project\":\"a b\"}"),
            good.replace("}", ",\"due\":\"overmorgen\"}"),
            good.replace("}", ",\"priority\":7}"),
            good.replace("}", ",\"account\":\"x'y\"}"),
            "12",
        )
        val decoded = QuickAddQueue.decode("""{"v":1,"items":[$good,${broken.joinToString(",")}]}""")
        assertEquals(listOf("Goed"), decoded.map { it.text })
        assertNull(decoded[0].accountId)
    }

    @Test
    fun `prioriteit in de tekst, en de tekst voor de app`() {
        for (t in listOf("Bellen p1", "p2 bellen", "Bellen !!3", "Bellen P4")) assertTrue(t, QuickAddQueue.hasPriority(t))
        for (t in listOf("Bellen", "Bellen p5", "app1", "help1", "Bellen p1x")) assertFalse(t, QuickAddQueue.hasPriority(t))
        assertEquals("Bellen p2", QuickAddQueue.textForApp(" Bellen ", 2))
        assertEquals("wat je typte gaat voor", "Bellen p1", QuickAddQueue.textForApp("Bellen p1", 3))
        assertEquals("P4 is geen prioriteit", "Bellen", QuickAddQueue.textForApp("Bellen", 4))
        assertEquals("Bellen", QuickAddQueue.textForApp("Bellen", null))
    }

    @Test
    fun `het antwoord van de server lezen - een taak, een voorvertoning, en wat geen antwoord van dit eindpunt is`() {
        val body = """{"quick_add":1,"dry_run":true,"repeated":false,"task":null,"preview":{"content":"Tandarts bellen","due":{"date":"2026-11-14T09:00","string":"morgen om 9 uur","lang":"nl"},
            "deadline":"2026-11-20","duration":null,"project":{"id":"project-thuis-01","name":"Thuis","inbox":false},"section":{"id":"s-1","name":"Klusjes"},
            "labels":[{"name":"bellen","new":false},{"name":"nieuw","new":true}],"priority":1,"reminders":[{"type":"relative","minute_offset":30},{"type":"absolute","date":"2026-11-14T08:00"},{"type":"location"}],"auto_reminder":false}}"""
        assertTrue(QuickAddParser.isQuickAdd(body))
        val p = QuickAddParser.preview(body)!!
        assertEquals("Tandarts bellen", p.content)
        assertEquals(PreviewDue("2026-11-14T09:00", "morgen om 9 uur", false), p.due)
        assertEquals("2026-11-20", p.deadline)
        assertEquals("project-thuis-01" to "Thuis", p.projectId to p.projectName)
        assertFalse(p.inbox)
        assertEquals("Klusjes", p.sectionName)
        assertEquals(listOf("bellen" to false, "nieuw" to true), p.labels)
        assertEquals(1, p.priority)
        assertEquals(listOf(PreviewReminder(30, null), PreviewReminder(null, "2026-11-14T08:00")), p.reminders)
        assertNull(QuickAddParser.taskId(body))
        assertEquals("abcdefgh12345678", QuickAddParser.taskId("""{"quick_add":1,"task":{"id":"abcdefgh12345678"}}"""))
        val recurring = QuickAddParser.preview("""{"quick_add":1,"preview":{"content":"x","due":{"date":"2026-11-17T20:00","string":"elke dinsdag om 20:00","recurrence":{"freq":"weekly"}},"project":{"id":"p-1","name":"Inbox","inbox":true},"labels":[],"priority":4,"reminders":[]}}""")!!
        assertTrue(recurring.due!!.recurring)
        assertTrue(recurring.inbox)
        assertEquals("een oudere server: geen markering", emptyList<PreviewSpan>(), recurring.spans)
        // welke tekst herkend is: wat niet klopt (onbekende soort, omgekeerd, negatief, te ver) valt weg
        val marked = QuickAddParser.preview("""{"quick_add":1,"preview":{"content":"x","project":{"id":"p-1","name":"Inbox","inbox":true},"labels":[],"priority":4,"reminders":[],
            "spans":[{"start":2,"end":8,"kind":"date"},{"start":9,"end":15,"kind":"project"},{"start":1,"end":3,"kind":"vreemd"},{"start":5,"end":5,"kind":"label"},{"start":-1,"end":2,"kind":"label"},{"start":1,"end":9999,"kind":"label"},"x"]}}""")!!
        assertEquals(listOf(PreviewSpan(2, 8, "date"), PreviewSpan(9, 15, "project")), marked.spans)
        for (bad in listOf(null, "", "{}", """{"error_code":"NOT_FOUND","error":"onbekend pad"}""", """{"quick_add":0}""")) assertFalse(bad ?: "null", QuickAddParser.isQuickAdd(bad))
        assertNull(QuickAddParser.preview("""{"quick_add":1,"preview":{"content":"x","project":{"id":"a b","name":"x"}}}"""))
        assertTrue(QuickAddParser.isDay("2026-11-14"))
        for (d in listOf("2026-02-30", "2026-11-14T09:00", "morgen", null)) assertFalse(QuickAddParser.isDay(d))
    }

    @Test
    fun `de keuzelijst - de Inbox eerst, dan de projectenboom zonder wat je alleen leest of gearchiveerd is`() {
        val s = snapshot(
            projects = listOf(
                project("inbox-project", "Inbox"), project("werk", "Werk", order = "b"), project("thuis", "Thuis", order = "a"),
                project("tuin", "Tuin", parent = "thuis"), project("oud", "Oud", archived = true), project("onder-oud", "Onder oud", parent = "oud"),
                project("gedeeld", "Gedeeld", readOnly = true, order = "c"), project("eigen-sub", "Eigen sub", parent = "gedeeld"),
            ),
        )
        val list = QuickAddChoices.list(s, "Inbox")
        assertEquals(listOf(null, "thuis", "tuin", "werk", "eigen-sub"), list.map { it.id })
        assertEquals(listOf(0, 0, 1, 0, 1), list.map { it.depth })
        assertEquals("zonder gegevens alleen de Inbox", listOf(QuickAddChoice(null, "Inbox", 0)), QuickAddChoices.list(null, "Inbox"))
        // het eerste project: dat van de widget, anders het laatst gekozen, anders de Inbox
        assertEquals("werk", QuickAddChoices.initial(list, "werk", "thuis", "inbox-project"))
        assertEquals("thuis", QuickAddChoices.initial(list, null, "thuis", "inbox-project"))
        assertEquals("een project dat je alleen leest niet", "thuis", QuickAddChoices.initial(list, "gedeeld", "thuis", "inbox-project"))
        assertNull("de Inbox-widget", QuickAddChoices.initial(list, "inbox-project", "thuis", "inbox-project"))
        assertNull(QuickAddChoices.initial(list, "weg", "ook-weg", "inbox-project"))
    }

    @Test
    fun `Openen in de app - tekst, project en dag als share-fragment, alleen geldige waarden`() {
        fun json(f: String?): String {
            assertNotNull(f)
            assertTrue(f, Regex("^share=[A-Za-z0-9_-]+$").matches(f!!))
            return String(Base64.getUrlDecoder().decode(f.removePrefix("share=")), Charsets.UTF_8)
        }
        assertEquals("""{"title":"Brood p2","text":"","project":"project-werk-001","due":"today"}""", json(ShareLink.draftFragment(" Brood p2 ", "project-werk-001", "today")))
        assertEquals("""{"title":"Brood","text":"","due":"2026-11-14"}""", json(ShareLink.draftFragment("Brood", null, "2026-11-14")))
        assertEquals("""{"title":"Brood","text":""}""", json(ShareLink.draftFragment("Brood", "a b", "morgen")))
        assertEquals("""{"title":"Brood","text":""}""", json(ShareLink.draftFragment("Brood", "x".repeat(41), "2026-02-30")))
        assertEquals("""{"title":"\"</script>","text":""}""", json(ShareLink.draftFragment("\"</script>", null, null)))
        assertNull(ShareLink.draftFragment("  ", "project-werk-001", "today"))
        assertNull(ShareLink.draftFragment(null, null, null))
        assertEquals(QuickAddQueue.MAX_TEXT + 22, json(ShareLink.draftFragment("a".repeat(5000), null, null)).length)
    }
}
