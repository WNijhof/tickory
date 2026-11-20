package io.github.wnijhof.tickory.widget

import android.content.Intent
import android.view.View
import android.widget.LinearLayout
import android.widget.TextView
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.core.list
import io.github.wnijhof.tickory.core.text
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.store.WidgetStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import java.time.LocalDate

/** Herplannen vanuit een widget (de knop naast "Over tijd"): het venster en wat het naar de server stuurt. */
class RescheduleUiTest : WidgetTestBase() {
    private val data = snapshot(listOf(task("oud1", "2026-11-12").copy(dueJson = """{"date":"2026-11-12T09:00"}"""), task("oud2", "2026-11-10"), task("nu", "2026-11-13")))

    private fun open(vararg ids: String) =
        Robolectric.buildActivity(RescheduleActivity::class.java, Intent(app, RescheduleActivity::class.java).putExtra(RescheduleActivity.EXTRA_TASK_IDS, arrayOf(*ids))).setup().get()

    @Test
    fun `het venster toont de keuzes met de weekdag, en het aantal te late taken`() {
        signIn(withData = data)
        val a = open("oud1", "oud2")
        assertFalse(a.isFinishing)
        assertEquals("2 over tijd", a.findViewById<TextView>(R.id.reschedule_count).text.toString())
        val box = a.findViewById<LinearLayout>(R.id.reschedule_choices)
        val labels = (0 until box.childCount).map { box.getChildAt(it).findViewById<TextView>(R.id.choice_label).text.toString() }
        assertEquals(listOf("Vandaag", "Morgen", "Dit weekend", "Volgende week", "Geen datum", "Datum kiezen…"), labels)
        assertEquals(View.VISIBLE, box.getChildAt(1).findViewById<View>(R.id.choice_hint).visibility)
        assertEquals("geen weekdag bij Geen datum", View.GONE, box.getChildAt(4).findViewById<View>(R.id.choice_hint).visibility)
    }

    @Test
    fun `onbekende, al afgevinkte of geen taken - het venster sluit meteen`() {
        signIn(withData = data)
        assertTrue(open("bestaat-niet").isFinishing)
        WidgetStore.enqueue(app, QueuedComplete("oud1", "tickory-w-0000000001", null, data.accountId, now))
        assertTrue("al afgevinkt", open("oud1").isFinishing)
        assertTrue(open().isFinishing)
    }

    @Test
    fun `naar de server - een task_update per taak met het tijdstip, en een fout zonder verbinding`() {
        val seen = ArrayList<Map<String, Any?>>()
        FakeServer { request ->
            val commands = Json.parseObject(request.body)?.list("commands").orEmpty().mapNotNull { Json.asObject(it) }
            seen.addAll(commands)
            Response(200, """{"sync_token":"9","sync_status":{${commands.joinToString(",") { "\"${it.text("uuid")}\":\"ok\"" }}},"settings":[]}""")
        }.use { server ->
            signIn(server.origin, data)
            val tasks = data.tasks.filter { it.id.startsWith("oud") }
            assertTrue(RescheduleActivity.send(app, tasks, LocalDate.parse("2026-11-14")))
            assertEquals(listOf("task_update", "task_update"), seen.map { it.text("type") })
            assertEquals("2026-11-14T09:00", Json.asObject(Json.asObject(seen[0]["args"])!!["due"])!!.text("date"))
            assertEquals("2026-11-14", Json.asObject(Json.asObject(seen[1]["args"])!!["due"])!!.text("date"))
        }
        // geen server op dit adres (zoals zonder verbinding): het lukt niet, en dat zegt het venster
        signIn("http://127.0.0.1:9", data)
        assertFalse(RescheduleActivity.send(app, data.tasks.take(1), LocalDate.parse("2026-11-14")))
    }

    @Test
    fun `de knop naast Over tijd opent het venster met precies die taken`() {
        signIn(withData = data)
        val intent = Intent(app, WidgetActionActivity::class.java)
            .putExtra(WidgetIntents.EXTRA_KIND, WidgetIntents.KIND_RESCHEDULE)
            .putExtra(RescheduleActivity.EXTRA_TASK_IDS, arrayOf("oud1", "oud2", "met spatie"))
        Robolectric.buildActivity(WidgetActionActivity::class.java, intent).setup()
        val started = shadowOf(app).nextStartedActivity
        assertEquals(RescheduleActivity::class.java.name, started.component!!.className)
        assertEquals(listOf("oud1", "oud2"), started.getStringArrayExtra(RescheduleActivity.EXTRA_TASK_IDS)!!.toList())
    }
}
