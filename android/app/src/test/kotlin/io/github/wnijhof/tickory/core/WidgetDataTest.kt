package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.syncBody
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.WidgetFixtures.taskJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Het antwoord van de server naar gegevens voor de widgets, en weer terug naar tekst op schijf. */
class WidgetDataTest {
    @Test
    fun `alleen open taken komen mee - geen afgevinkte, geen verwijderde, geen kapotte`() {
        val body = syncBody(
            tasksJson = "[" + listOf(
                taskJson("open-1", "2026-11-13", priority = 1),
                taskJson("klaar-1", checked = true),
                taskJson("weg-1", deleted = true),
                taskJson("terug-1", "2026-11-13", recurring = true),
                """{"id":"a b","project_id":"inbox-project","content":"kapot id"}""",
                """{"id":"zonder-project","content":"geen project"}""",
                "5", "null", """"tekst"""",
            ).joinToString(",") + "]",
        )
        val snapshot = WidgetParser.parse(body)!!
        assertEquals("user-anna-0001", snapshot.accountId)
        assertEquals("inbox-project", snapshot.inboxId)
        assertEquals(listOf("open-1", "terug-1"), snapshot.tasks.map { it.id })
        assertEquals(1, snapshot.tasks[0].priority)
        assertEquals("2026-11-13", snapshot.tasks[0].due)
        assertFalse(snapshot.tasks[0].recurring)
        assertTrue("een herhaling wordt herkend", snapshot.tasks[1].recurring)
    }

    @Test
    fun `projecten, secties en labels - verwijderde en kapotte overgeslagen`() {
        val body = syncBody(
            projectsJson = """[{"id":"inbox-project","name":"Inbox","is_deleted":false},{"id":"weg-0001","name":"Weg","is_deleted":true},
                {"id":"werk-001","name":"Werk","parent_id":"inbox-project","is_archived":true,"order_key":"a1"},{"name":"zonder id"}]""",
            sectionsJson = """[{"id":"sec-0001","project_id":"werk-001","name":"Nu","order_key":"a1"},{"id":"sec-0002","project_id":"werk-001","name":"Weg","is_deleted":true}]""",
            labelsJson = """[{"id":"lab-0001","name":"bellen"},{"id":"lab-0002","name":"weg","is_deleted":true}]""",
        )
        val snapshot = WidgetParser.parse(body)!!
        assertEquals(listOf("inbox-project", "werk-001"), snapshot.projects.map { it.id })
        assertTrue(snapshot.projects[1].archived)
        assertEquals("inbox-project", snapshot.projects[1].parentId)
        assertEquals(listOf("sec-0001"), snapshot.sections.map { it.id })
        assertEquals(listOf("lab-0001"), snapshot.labels.map { it.id })
    }

    @Test
    fun `alleen lezen - een project waar je lezer bent (rol viewer), en dat blijft zo na bewaren en teruglezen`() {
        val projects = "[" + listOf("inbox-project", "gelezen", "samen", "anders").joinToString(",") { """{"id":"$it","name":"$it","parent_id":null,"is_archived":false,"order_key":"a0","is_deleted":false}""" } + "]"
        val members = """[{"project_id":"gelezen","user_id":"user-anna-0001","role":"viewer"},{"project_id":"samen","user_id":"user-anna-0001","role":"member"},
            {"project_id":"anders","user_id":"user-bram-0001","role":"viewer"},{"project_id":"anders","user_id":"user-anna-0001","role":"owner"},{"id":"x","is_deleted":true}]"""
        val snapshot = WidgetParser.parse(syncBody(projectsJson = projects, membersJson = members))!!
        assertEquals(listOf("gelezen"), snapshot.projects.filter { it.readOnly }.map { it.id })
        assertEquals(snapshot, WidgetCodec.decode(WidgetCodec.encode(snapshot)))
        // een server die geen leden meestuurt: niets is alleen lezen (de server weigert het afvinken dan zelf)
        assertTrue(WidgetParser.parse(syncBody(projectsJson = projects))!!.projects.none { it.readOnly })
        // een bewaarde tekst van vóór de rollen: ook niets alleen lezen
        assertFalse(WidgetCodec.decode(WidgetCodec.encode(snapshot).replace("\"readOnly\":true", "\"x\":1"))!!.projects.any { it.readOnly })
    }

    @Test
    fun `een onbruikbaar antwoord geeft niets, zodat de widgets laten staan wat er was`() {
        assertNull(WidgetParser.parse(null))
        assertNull(WidgetParser.parse(""))
        assertNull(WidgetParser.parse("geen json"))
        assertNull(WidgetParser.parse("[]"))
        assertNull("zonder gebruiker weten we niet van wie het is", WidgetParser.parse("""{"tasks":[],"projects":[]}"""))
        assertNull(WidgetParser.parse("""{"me":{"id":"een id met spaties"},"tasks":[],"projects":[]}"""))
        assertNull("zonder taken", WidgetParser.parse("""{"me":{"id":"user-1"},"projects":[]}"""))
        assertNull("zonder projecten", WidgetParser.parse("""{"me":{"id":"user-1"},"tasks":[]}"""))
        assertEquals(emptyList<WidgetTask>(), WidgetParser.parse("""{"me":{"id":"user-1"},"tasks":[],"projects":[]}""")!!.tasks)
    }

    @Test
    fun `titels worden schoongemaakt en ingekort`() {
        val long = "a".repeat(500)
        val body = syncBody(tasksJson = "[" + taskJson("t1", content = "  veel   spaties\\n erin ") + "," + taskJson("t2", content = long) + "]")
        val tasks = WidgetParser.parse(body)!!.tasks
        assertEquals("veel spaties erin", tasks[0].content)
        assertEquals(SyncParser.MAX_TITLE_LENGTH, tasks[1].content.length)
    }

    @Test
    fun `meer dan het maximum aan taken wordt afgekapt`() {
        val many = (1..WidgetParser.MAX_TASKS + 50).joinToString(",", "[", "]") { taskJson("t$it") }
        assertEquals(WidgetParser.MAX_TASKS, WidgetParser.parse(syncBody(tasksJson = many))!!.tasks.size)
    }

    @Test
    fun `bewaren en teruglezen geeft hetzelfde, ook met Nederlandse tekens`() {
        val s = snapshot(
            tasks = listOf(task("a", "2026-11-13T09:00", content = "Café reserveren – “ëëén” 🙂", recurring = true, priority = 2, labels = listOf("l1"))),
            projects = listOf(WidgetFixtures.project("inbox-project", "Inbox"), WidgetFixtures.project("werk", "Werk & Privé", parent = "inbox-project", archived = true)),
            sections = listOf(WidgetSection("s1", "werk", "Deze week", false, "a1")),
            labels = listOf(WidgetLabel("l1", "bellen")),
        )
        assertEquals(s, WidgetCodec.decode(WidgetCodec.encode(s)))
    }

    @Test
    fun `onleesbare of vreemde bewaarde tekst geeft niets in plaats van een fout`() {
        for (bad in listOf(null, "", "{", "[]", """{"v":2,"account":"x"}""", """{"v":1}""", """{"v":1,"account":"met spatie"}""")) {
            assertNull("'$bad'", WidgetCodec.decode(bad))
        }
        val good = WidgetCodec.encode(snapshot(listOf(task("a"))))
        assertNull("afgekapt", WidgetCodec.decode(good.take(good.length / 2)))
    }

    @Test
    fun `een taak met een kapot id in de bewaarde tekst wordt overgeslagen`() {
        val text = """{"v":1,"account":"user-1","inbox":null,"tasks":[{"id":"niet ok","project":"p"},{"id":"ok","project":"p","content":"x","priority":9}],"projects":[],"sections":[],"labels":[]}"""
        val s = WidgetCodec.decode(text)!!
        assertEquals(listOf("ok"), s.tasks.map { it.id })
        assertEquals("een onmogelijke prioriteit wordt 4", 4, s.tasks[0].priority)
    }

    // ---------- diepe links ----------

    @Test
    fun `diepe links - een taak gaat voor, Taak toevoegen met of zonder doel, onzin valt terug`() {
        assertEquals("task=abc-123", DeepLink.fromExtras("abc-123", false, null))
        assertEquals("task=abc-123", DeepLink.fromExtras("abc-123", true, "today"))
        assertEquals("add", DeepLink.fromExtras(null, true, ""))
        assertEquals("add", DeepLink.fromExtras(null, true, null))
        assertEquals("add=today", DeepLink.fromExtras(null, true, "today"))
        assertEquals("add=inbox-project", DeepLink.fromExtras(null, true, "inbox-project"))
        assertNull(DeepLink.fromExtras(null, false, "today"))
        assertNull(DeepLink.fromExtras("x';alert(1);'", false, null))
        for (bad in listOf("a b", "x';alert(1);'", "../x", "a#b", "<script>", "a=b")) {
            assertEquals("'$bad'", "add", DeepLink.add(bad))
            assertNull("'$bad'", DeepLink.task(bad))
        }
    }

    @Test
    fun `diepe links - alleen veilige fragmenten komen in het webadres en in JavaScript`() {
        for (ok in listOf("task=abc-123", "add", "add=today", "share=eyJ0aXRsZSI6IngifQ", "share=" + "A".repeat(40_000))) assertTrue(ok.take(30), DeepLink.isSafe(ok))
        for (bad in listOf(null, "", "x';alert(1);'", "a b", "a#b", "a\"b", "<script>", "a/b", "a&b=1", "a;b", "a\nb", "share=" + "A".repeat(100_001))) assertFalse("'$bad'", DeepLink.isSafe(bad))
    }

    // ---------- de wachtrij ----------

    private fun item(task: String, uuid: String = "tickory-w-$task", account: String = "user-1", at: Long = 1_000L, ifDue: String? = null) =
        QueuedComplete(task, uuid, ifDue, account, at)

    @Test
    fun `wachtrij - dubbel tikken blijft een actie, per gebruiker`() {
        val (one, added) = WidgetQueue.enqueue(emptyList(), item("t1"))
        assertTrue(added)
        val (again, addedAgain) = WidgetQueue.enqueue(one, item("t1", uuid = "tickory-w-ander"))
        assertFalse(addedAgain)
        assertEquals(one, again)
        val (other, addedOther) = WidgetQueue.enqueue(one, item("t1", account = "user-2"))
        assertTrue("dezelfde taak-id bij een andere gebruiker is iets anders", addedOther)
        assertEquals(2, other.size)
        assertEquals(listOf("t1"), WidgetQueue.forAccount(other, "user-2").map { it.taskId })
        assertEquals(emptyList<QueuedComplete>(), WidgetQueue.forAccount(other, null))
    }

    @Test
    fun `wachtrij - afhandelen, te lang wachten en zonder if_due opnieuw`() {
        val items = listOf(item("a", at = 0), item("b", at = WidgetQueue.RETENTION_MS + 5, ifDue = "2026-11-13"))
        assertEquals(listOf("b"), WidgetQueue.settle(items, setOf("tickory-w-a")).map { it.taskId })
        assertEquals("nog niet te lang", emptyList<QueuedComplete>(), WidgetQueue.expired(items, WidgetQueue.RETENTION_MS))
        assertEquals(listOf("a"), WidgetQueue.expired(items, WidgetQueue.RETENTION_MS + 1).map { it.taskId })
        val downgraded = WidgetQueue.withoutGuard(items, "tickory-w-b", "tickory-w-nieuw")
        assertEquals(null, downgraded[1].ifDue)
        assertEquals("tickory-w-nieuw", downgraded[1].uuid)
        assertEquals("de rest blijft", items[0], downgraded[0])
    }

    @Test
    fun `wachtrij - uuid's zijn uniek en hebben de vorm die de server vraagt`() {
        val ids = (1..500).map { WidgetQueue.newUuid() }
        assertEquals(500, ids.toSet().size)
        for (id in ids) assertTrue(id, Regex("^tickory-w-[0-9a-f]{24}$").matches(id) && id.length in 8..64)
        var n = 0
        assertEquals("tickory-w-000102030405060708090a0b", WidgetQueue.newUuid { n++ })
        assertNotEquals(WidgetQueue.newUuid { 0 }, WidgetQueue.newUuid { 255 })
    }

    @Test
    fun `wachtrij - bewaren en teruglezen, en kapotte regels worden overgeslagen`() {
        val items = listOf(item("a", ifDue = "2026-11-13T09:00"), item("b", account = "user-2", at = 5))
        assertEquals(items, WidgetQueue.decode(WidgetQueue.encode(items)))
        assertEquals(emptyList<QueuedComplete>(), WidgetQueue.decode(null))
        assertEquals(emptyList<QueuedComplete>(), WidgetQueue.decode("kapot"))
        assertEquals(emptyList<QueuedComplete>(), WidgetQueue.decode("""{"v":2,"items":[]}"""))
        val text = """{"v":1,"items":[{"task":"niet ok","uuid":"tickory-w-aaaaaaaa","account":"u","at":1},{"task":"t1","uuid":"kort","account":"u","at":1},
            {"task":"t2","uuid":"tickory-w-bbbbbbbb","account":"u"},{"task":"t3","uuid":"tickory-w-cccccccc","account":"u","at":1},5]}"""
        assertEquals(listOf("t3"), WidgetQueue.decode(text).map { it.taskId })
    }

    // ---------- herinneringen van een afgevinkte taak ----------

    @Test
    fun `lokaal afgevinkt - herinneringen en uitstel van die taak vervallen meteen`() {
        val tasks = listOf(TaskInfo("t1", "Een", "2026-11-13T14:00"), TaskInfo("t2", "Twee", "2026-11-13T15:00"))
        val reminders = listOf(ReminderInfo("r1", "t1", "relative", 30, null), ReminderInfo("r2", "t2", "relative", 30, null))
        val snooze = SnoozedReminder("r1", "t1", "Een", "2026-11-13T14:00", 0, 10)
        val state = ReminderState(snapshot = SyncSnapshot(tasks, reminders), snoozed = mapOf("r1" to snooze))

        val (after, dropped) = ReminderLogic.completedLocally(state, setOf("t1"))
        assertEquals(setOf("r1"), dropped)
        assertTrue(after.snoozed.isEmpty())
        val now = WidgetFixtures.at("2026-11-13T09:00")
        val plan = ReminderLogic.replan(after, now, WidgetFixtures.amsterdam)
        assertEquals("alleen de herinnering van de andere taak blijft", listOf("r2"), plan.schedule.map { it.reminderId })
        // en zonder deze stap zou de herinnering van t1 nog staan
        assertEquals(listOf("r1", "r2"), ReminderLogic.replan(state.copy(snoozed = emptyMap()), now, WidgetFixtures.amsterdam).schedule.map { it.reminderId })
    }
}
