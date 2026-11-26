package io.github.wnijhof.tickory.widget

import android.os.Looper
import android.view.View
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ApiClient
import io.github.wnijhof.tickory.core.FakeServer
import io.github.wnijhof.tickory.core.FakeServer.Response
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.syncBody
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.WidgetLabel
import io.github.wnijhof.tickory.core.list
import io.github.wnijhof.tickory.core.obj
import io.github.wnijhof.tickory.core.text
import io.github.wnijhof.tickory.core.whole
import io.github.wnijhof.tickory.store.WidgetStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.android.controller.ActivityController
import org.robolectric.shadows.ShadowToast
import java.time.LocalDate
import java.util.concurrent.Executor

/** Het venster van een taak uit een widget: bewerken zoals bij Todoist, en vanzelf opslaan bij het sluiten. */
class TaskPopupTest : WidgetTestBase() {
    private val data = snapshot(
        tasks = listOf(
            task("t1", due = "2026-11-26T09:00", content = "Tandarts bellen", priority = 2, labels = listOf("l1")).copy(description = "Nummer in de mail"),
            task("t2", content = "Gedeelde taak", project = "gedeeld"),
            task("t3", content = "Lang").copy(description = null, hasDescription = true),
        ),
        projects = listOf(project("inbox-project", "Inbox"), project("werk", "Werk", order = "a"), project("gedeeld", "Gedeeld", readOnly = true, order = "b")),
        labels = listOf(WidgetLabel("l1", "bellen"), WidgetLabel("l2", "thuis")),
    )
    private val originalExecutor = TaskPopupActivity.saveExecutor

    @Before
    fun setUp() {
        TaskPopupActivity.saveExecutor = Executor { it.run() }
    }

    @After
    fun tearDown() {
        TaskPopupActivity.saveExecutor = originalExecutor
    }

    /** Een server die elk commando goedkeurt (of, met [ok] false, de verbinding weigert met een fout). */
    private fun server(ok: Boolean = true): FakeServer = FakeServer { request ->
        val commands = Json.parseObject(request.body)?.list("commands").orEmpty().mapNotNull { Json.asObject(it)?.text("uuid") }
        when {
            !ok -> Response(503, """{"error_code":"UNAVAILABLE","error":"even niet"}""")
            commands.isEmpty() -> Response(200, syncBody())
            else -> Response(200, """{"sync_status":{${commands.joinToString(",") { "\"$it\":\"ok\"" }}}}""")
        }
    }

    private fun open(id: String = "t1"): ActivityController<TaskPopupActivity> =
        Robolectric.buildActivity(TaskPopupActivity::class.java, WidgetIntents.taskPopup(app, id)).setup()

    private val TaskPopupActivity.titleField get() = findViewById<EditText>(R.id.popup_content)
    private val TaskPopupActivity.description get() = findViewById<EditText>(R.id.popup_description)
    private val TaskPopupActivity.status get() = findViewById<TextView>(R.id.popup_status)
    private val TaskPopupActivity.rows get() = findViewById<LinearLayout>(R.id.popup_rows).let { box ->
        (0 until box.childCount).map { i -> box.getChildAt(i).let { it.findViewById<TextView>(R.id.choice_label).text.toString() to it.findViewById<TextView>(R.id.choice_hint).text.toString() } }
    }

    private fun sentCommands(server: FakeServer) = server.requests.filter { it.path == ApiClient.SYNC_PATH }
        .flatMap { r -> Json.parseObject(r.body)?.list("commands").orEmpty().mapNotNull { Json.asObject(it) } }
        .filter { it.text("type") != null }

    @Test
    fun `het venster toont de taak om te bewerken - titel, beschrijving, project, datum, prioriteit en labels`() {
        signIn(withData = data)
        val popup = open().get()
        assertFalse(popup.isFinishing)
        assertEquals("Tandarts bellen", popup.titleField.text.toString())
        assertEquals("Nummer in de mail", popup.description.text.toString())
        assertTrue(popup.titleField.isEnabled && popup.description.isEnabled)
        assertTrue(popup.findViewById<Button>(R.id.popup_project).text.startsWith("Inbox"))
        assertEquals(listOf("Datum", "Prioriteit", "Labels"), popup.rows.map { it.first })
        assertEquals("Prioriteit 2", popup.rows[1].second)
        assertEquals("@bellen", popup.rows[2].second)
    }

    @Test
    fun `terug slaat op wat er veranderd is en sluit`() {
        server().use { server ->
            signIn(server.origin, data)
            val popup = open().get()
            popup.titleField.setText("Tandarts bellen voor controle")
            popup.description.setText("")
            popup.setPriority(1)
            popup.setLabels(listOf("l1", "l2"))
            popup.setDue(LocalDate.of(2026, 11, 30))
            popup.setProject("werk")
            assertEquals("Prioriteit 1 (hoogste)", popup.rows[1].second)
            assertEquals("@bellen, @thuis", popup.rows[2].second)
            assertTrue(popup.findViewById<Button>(R.id.popup_project).text.startsWith("Werk"))
            popup.onBackPressedDispatcher.onBackPressed()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(popup.isFinishing)
            assertEquals("Opgeslagen", ShadowToast.getTextOfLatestToast())
            val sent = sentCommands(server)
            assertEquals(listOf("task_update", "task_move"), sent.map { it.text("type") })
            val args = sent[0].obj("args")!!
            assertEquals("Tandarts bellen voor controle", args.text("content"))
            assertEquals("", args.text("description"))
            assertEquals(1L, args.whole("priority"))
            assertEquals(listOf("l1", "l2"), args.list("labels"))
            assertEquals("2026-11-30T09:00", args.obj("due")?.text("date"))
            assertEquals("werk", sent[1].obj("args")?.text("project_id"))
        }
    }

    @Test
    fun `niets veranderd - dicht zonder iets te versturen, en Klaar op het toetsenbord slaat op`() {
        server().use { server ->
            signIn(server.origin, data)
            val popup = open().get()
            popup.findViewById<View>(R.id.popup_root).performClick()
            assertTrue(popup.isFinishing)
            assertTrue(sentCommands(server).isEmpty())

            val again = open().get()
            again.titleField.setText("Tandarts bellen morgen")
            again.titleField.onEditorAction(EditorInfo.IME_ACTION_DONE)
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(again.isFinishing)
            assertEquals(listOf("Tandarts bellen morgen"), sentCommands(server).map { it.obj("args")?.text("content") })
        }
    }

    @Test
    fun `geen verbinding - het venster blijft open met de reden, nog een keer terug gooit weg`() {
        server(ok = false).use { server ->
            signIn(server.origin, data)
            val popup = open().get()
            popup.setPriority(3)
            popup.onBackPressedDispatcher.onBackPressed()
            shadowOf(Looper.getMainLooper()).idle()
            assertFalse("blijft open, niets kwijt", popup.isFinishing)
            assertEquals(View.VISIBLE, popup.status.visibility)
            assertTrue(popup.status.text.startsWith("Niet opgeslagen"))
            popup.onBackPressedDispatcher.onBackPressed()
            assertTrue(popup.isFinishing)
            assertEquals("Wijzigingen niet opgeslagen", ShadowToast.getTextOfLatestToast())
        }
    }

    @Test
    fun `naar de achtergrond (thuisknop) - op de achtergrond opslaan en dicht`() {
        server().use { server ->
            signIn(server.origin, data)
            val controller = open()
            controller.get().setPriority(1)
            controller.pause().stop()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(controller.get().isFinishing)
            assertEquals(listOf(1L), sentCommands(server).map { it.obj("args")?.whole("priority") })
        }
    }

    @Test
    fun `een project dat je alleen leest - alleen bekijken, en een onbekende beschrijving is niet te bewerken`() {
        server().use { server ->
            signIn(server.origin, data)
            val shared = open("t2").get()
            assertEquals(View.GONE, shared.findViewById<View>(R.id.popup_complete).visibility)
            assertEquals("Dit project kun je alleen bekijken", shared.status.text.toString())
            shared.setPriority(1) // de regels zijn niet aan te tikken; ook zo gaat er niets naar de server
            shared.onBackPressedDispatcher.onBackPressed()
            assertTrue(shared.isFinishing)
            assertTrue(sentCommands(server).isEmpty())

            val long = open("t3").get()
            assertFalse(long.description.isEnabled)
            assertEquals("Bewerk de beschrijving in de app", long.description.hint.toString())
            // naar een project dat je alleen leest kan niet
            long.setProject("gedeeld")
            assertTrue(long.findViewById<Button>(R.id.popup_project).text.startsWith("Inbox"))
        }
    }

    @Test
    fun `Voltooien slaat eerst op en vinkt dan af zoals in de widget`() {
        server().use { server ->
            signIn(server.origin, data)
            val popup = open().get()
            popup.titleField.setText("Tandarts gebeld")
            popup.findViewById<View>(R.id.popup_complete).performClick()
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(popup.isFinishing)
            assertEquals(listOf("t1"), WidgetStore.queue(app).map { it.taskId })
            assertTrue(sentCommands(server).any { it.obj("args")?.text("content") == "Tandarts gebeld" })
        }
    }
}
