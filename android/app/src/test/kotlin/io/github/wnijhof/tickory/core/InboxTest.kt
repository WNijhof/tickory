package io.github.wnijhof.tickory.core

import io.github.wnijhof.tickory.core.FakeServer.Response
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** Meldingen bij samenwerken: het antwoord van de server lezen en beslissen wat er op het toestel komt en weer weggaat. */
class InboxTest {
    private val now = Instant.parse("2030-06-14T10:00:00Z").toEpochMilli()
    private fun at(minutesAgo: Long) = Instant.ofEpochMilli(now - minutesAgo * 60_000).toString()

    private fun notification(id: String, kind: String, minutesAgo: Long = 5, read: Boolean = false, task: String? = "task-0001", project: String? = null, comment: String? = null, owner: String = "user-anna") =
        """{"id":"$id","kind":"$kind","actor_id":"user-bram","task_id":${task?.let { "\"$it\"" }},"project_id":${project?.let { "\"$it\"" }},"comment_id":${comment?.let { "\"$it\"" }},"is_read":$read,"owner_id":"$owner","created_at":"${at(minutesAgo)}","is_deleted":false}"""

    private fun body(notifications: List<String>, push: String = "null", comments: String? = """[{"id":"comm-0001","content":"Hoi  @Anna,\nkun jij dit doen?","is_deleted":false}]""") = """{
        "sync_token":"9","me":{"id":"user-anna","name":"Anna"},
        "users":[{"id":"user-anna","name":"Anna"},{"id":"user-bram","name":"Bram"}],
        "tasks":[{"id":"task-0001","project_id":"proj-0001","content":"Tegels kiezen","checked":false,"is_deleted":false}],
        "projects":[{"id":"proj-0001","name":"Verbouwing","is_deleted":false}],
        ${comments?.let { "\"comments\":$it," } ?: ""}
        "settings":[{"id":"settings-user-anna","owner_id":"user-anna","notify_push":$push}],
        "reminders":[],
        "notifications":[${notifications.joinToString(",")}]}"""

    @Test
    fun `lezen - titel, project, wie en het begin van de opmerking, alleen eigen meldingen over wat er nog is`() {
        val snap = InboxParser.parse(
            body(listOf(
                notification("n-assigned", "assigned"),
                notification("n-mention", "mention", comment = "comm-0001"),
                notification("n-shared", "shared", task = null, project = "proj-0001", read = true),
                notification("n-gone-task", "assigned", task = "task-weg"),
                notification("n-gone-comment", "comment", comment = "comm-weg"),
                notification("n-other", "assigned", owner = "user-bram"),
                """{"id":"n-deleted","is_deleted":true}""",
                """{"id":"n bad id","kind":"assigned"}""",
            )),
        )!!
        assertEquals("user-anna", snap.accountId)
        assertEquals(listOf("n-assigned", "n-mention", "n-shared"), snap.items.map { it.id })
        val mention = snap.items[1]
        assertEquals(listOf("mention", "Bram", "Tegels kiezen", "Verbouwing", "Hoi @Anna, kun jij dit doen?"), listOf(mention.kind, mention.actor, mention.title, mention.project, mention.text))
        val shared = snap.items[2]
        assertEquals(listOf<Any?>("Verbouwing", null, null, "proj-0001", true), listOf(shared.title, shared.project, shared.taskId, shared.projectId, shared.isRead))
        assertEquals(InboxParser.DEFAULT_PUSH, snap.push)
        assertEquals(false, snap.push["completed"])
    }

    @Test
    fun `lezen - eigen keuze per soort, zonder opmerkingen geen tekst, en een oudere server zonder meldingen geeft null`() {
        val snap = InboxParser.parse(body(listOf(notification("n-mention", "mention", comment = "comm-0001")), push = """{"completed":true,"comment":false,"onbekend":true,"mention":"ja"}""", comments = null))!!
        assertEquals(mapOf("assigned" to true, "comment" to false, "mention" to true, "completed" to true, "shared" to true), snap.push)
        assertNull("zonder opmerkingen in het antwoord: wel de melding, geen tekst", snap.items.single().text)
        assertNull(InboxParser.parse("""{"me":{"id":"user-anna"},"tasks":[],"reminders":[]}"""))
        assertNull(InboxParser.parse("geen json"))
        assertNull(InboxParser.parse("""{"notifications":[]}"""))
    }

    private fun snap(vararg items: InboxItem, push: Map<String, Boolean> = InboxParser.DEFAULT_PUSH, account: String = "user-anna") = InboxSnapshot(account, items.toList(), push)
    private fun item(id: String, kind: String = "assigned", minutesAgo: Long = 5, read: Boolean = false) =
        InboxItem(id, kind, "Bram", "Tegels kiezen", "Verbouwing", null, "task-0001", null, read, now - minutesAgo * 60_000)

    @Test
    fun `beslissen - de eerste keer niets tonen, daarna alleen nieuwe ongelezen, elk hooguit een keer`() {
        val first = InboxPlan.decide(null, snap(item("n-1"), item("n-2", read = true)), now, appVisible = false)
        assertEquals(emptyList<InboxItem>(), first.show)
        assertEquals(setOf("n-1", "n-2"), first.next.known)

        val second = InboxPlan.decide(first.next, snap(item("n-1"), item("n-2", read = true), item("n-3"), item("n-4", read = true)), now, false)
        assertEquals(listOf("n-3"), second.show.map { it.id })
        assertEquals(setOf("n-3"), second.next.shown)

        val again = InboxPlan.decide(second.next, snap(item("n-1"), item("n-3"), item("n-4", read = true)), now, false)
        assertEquals("geen dubbele melding", emptyList<InboxItem>(), again.show)
        assertEquals(emptySet<String>(), again.cancel)
        assertEquals("een verdwenen melding (n-2) vergeten we", setOf("n-1", "n-3", "n-4"), again.next.known)
    }

    @Test
    fun `beslissen - gelezen of verdwenen haalt de melding weg`() {
        val state = InboxState("user-anna", setOf("n-1", "n-2"), setOf("n-1", "n-2"))
        val d = InboxPlan.decide(state, snap(item("n-1", read = true)), now, false)
        assertEquals(setOf("n-1", "n-2"), d.cancel)
        assertEquals(emptySet<String>(), d.next.shown)
    }

    @Test
    fun `beslissen - soort uit, te oud of de app staat open - niet tonen, en later ook niet`() {
        val state = InboxState("user-anna", emptySet(), emptySet())
        val d = InboxPlan.decide(state, snap(item("n-done", kind = "completed"), item("n-old", minutesAgo = 4 * 24 * 60), item("n-new")), now, false)
        assertEquals(listOf("n-new"), d.show.map { it.id })
        assertEquals(setOf("n-done", "n-old", "n-new"), d.next.known)
        val open = InboxPlan.decide(d.next, snap(item("n-done", kind = "completed"), item("n-old", minutesAgo = 4 * 24 * 60), item("n-new"), item("n-while-open")), now, true)
        assertEquals("de app staat open: je ziet het in de app", emptyList<InboxItem>(), open.show)
        val later = InboxPlan.decide(open.next, snap(item("n-while-open")), now, false)
        assertEquals(emptyList<InboxItem>(), later.show)
        val on = InboxPlan.decide(InboxState("user-anna", emptySet(), emptySet()), snap(item("n-done", kind = "completed"), push = InboxParser.DEFAULT_PUSH + ("completed" to true)), now, false)
        assertEquals(listOf("n-done"), on.show.map { it.id })
    }

    @Test
    fun `beslissen - een ander account begint opnieuw en haalt weg wat er van de vorige stond, hooguit tien tegelijk`() {
        val old = InboxState("user-bram", setOf("x-1"), setOf("x-1"))
        val d = InboxPlan.decide(old, snap(item("n-1")), now, false)
        assertEquals(setOf("x-1"), d.cancel)
        assertEquals(emptyList<InboxItem>(), d.show)
        assertEquals("user-anna", d.next.account)
        val many = (1..15).map { item("n-many-$it", minutesAgo = 20L - it) }.toTypedArray()
        val burst = InboxPlan.decide(InboxState("user-anna", emptySet(), emptySet()), snap(*many), now, false)
        assertEquals((6..15).map { "n-many-$it" }, burst.show.map { it.id })
        assertEquals("de rest is bekend en komt later niet alsnog", 15, burst.next.known.size)
    }

    @Test
    fun `de bewaarde toestand - heen en terug, en onzin of een andere versie geeft null`() {
        val s = InboxState("user-anna", setOf("n-1", "n-2"), setOf("n-2"))
        assertEquals(s, InboxState.decode(s.encode()))
        assertNull(InboxState.decode("""{"v":2,"account":"user-anna","known":[],"shown":[]}"""))
        assertNull(InboxState.decode("onzin"))
        assertEquals(setOf("n-1"), InboxState.decode("""{"v":1,"account":"user-anna","known":["n-1","<script>"],"shown":[]}""")!!.known)
    }

    @Test
    fun `een tik op een melding opent de web-app op notification=id, een vreemd id niet`() {
        assertEquals("notification=n-0001", DeepLink.notification("n-0001"))
        assertNull(DeepLink.notification("n 1"))
        assertNull(DeepLink.notification(null))
        assertTrue(DeepLink.isSafe(DeepLink.notification("n-0001")))
    }

    @Test
    fun `ophalen - een server zonder meldingen weigert het verzoek, dan met alleen plaatsen, en de meldingen blijven leeg`() {
        FakeServer { request ->
            val types = Json.parseObject(request.body)!!.list("resource_types")!!
            if (types.contains("notifications")) Response(400, """{"error_code":"INVALID_REQUEST","error":"onbekend resourcetype \"notifications\""}""")
            else Response(200, """{"sync_token":"9","me":{"id":"user-anna"},"tasks":[],"reminders":[],"projects":[],"places":[]}""")
        }.use { server ->
            val result = ApiClient(server.origin, 5_000, 5_000).fetchSnapshot("tky_test")
            assertTrue("$result", result is FetchResult.Ok)
            assertNull((result as FetchResult.Ok).inbox)
            assertEquals(2, server.requests.size)
            assertTrue(Json.parseObject(server.requests[1].body)!!.list("resource_types")!!.contains("places"))
        }
        FakeServer { Response(200, body(listOf(notification("n-1", "assigned")))) }.use { server ->
            val result = ApiClient(server.origin, 5_000, 5_000).fetchSnapshot("tky_test") as FetchResult.Ok
            assertNotNull(result.inbox)
            assertEquals(listOf("n-1"), result.inbox!!.items.map { it.id })
            assertFalse(result.inbox!!.items.single().isRead)
        }
    }
}
