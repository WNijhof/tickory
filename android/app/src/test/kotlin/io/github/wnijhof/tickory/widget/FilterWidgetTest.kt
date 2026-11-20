package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.Intent
import android.view.View
import android.widget.FrameLayout
import android.widget.ListView
import android.widget.TextView
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetFilter
import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.store.WidgetStore
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf

/** Een opgeslagen filter in de widget "Project of lijst" op een nagebootst Android (vrijdag 13 november 2026, 09:00). */
class FilterWidgetTest : WidgetTestBase() {
    private val manager: AppWidgetManager get() = AppWidgetManager.getInstance(app)

    private val data = snapshot(
        tasks = listOf(
            task("t1", "2026-11-13T14:00", content = "Tandarts bellen", priority = 1, project = "werk"),
            task("t2", "2026-11-12", content = "Boodschappen", priority = 3),
            task("t3", "2026-11-14T10:00", content = "Bakker", project = "werk"),
            task("t4", content = "Zonder datum", project = "werk"),
        ),
        projects = listOf(project("inbox-project", "Inbox"), project("werk", "Werk")),
    ).copy(
        filters = listOf(
            WidgetFilter("f-dringend", "Dringend", "p1 | te laat", "a0"),
            WidgetFilter("f-lijsten", "Vandaag en werk", "Nu: vandaag | te laat, Werk: #Werk", "a1"),
            WidgetFilter("f-donderdag", "Donderdag", "donderdag & p1", "a2"),
            WidgetFilter("f-weg", "Oud project", "#Verdwenen | p1", "a3"),
        ),
    )

    private fun place(): Int = shadowOf(manager).createWidget(ProjectWidgetProvider::class.java, R.layout.widget_list)
    private fun view(id: Int): View = shadowOf(manager).getViewFor(id)
    private fun text(view: View, id: Int): String = view.findViewById<TextView>(id).text.toString()
    private fun factory(id: Int): WidgetListService.Factory = WidgetListService.Factory(app, id).also { it.onDataSetChanged() }
    private fun row(f: WidgetListService.Factory, position: Int): View = f.getViewAt(position)!!.apply(app, FrameLayout(app))
    private fun titles(f: WidgetListService.Factory): List<String> = (0 until f.count).map { i ->
        val v = row(f, i)
        v.findViewById<TextView>(R.id.item_title)?.text?.toString() ?: "# " + text(v, R.id.header_label)
    }

    private fun choose(id: Int, key: String) {
        WidgetConfigStore.set(app, id, key)
        WidgetUpdater.updateAll(app)
    }

    @Test
    fun `configuratie - de opgeslagen filters staan na de projecten, en kiezen toont het filter`() {
        signIn(withData = data)
        val id = place()
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, Intent(app, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)).setup().get()
        val list = activity.findViewById<ListView>(R.id.config_list)
        val choices = (list.adapter as android.widget.HeaderViewListAdapter).wrappedAdapter
        val labels = (0 until choices.count).map { choices.getView(it, null, list).findViewById<TextView>(R.id.choice_label).text.toString() }
        assertEquals(
            listOf("Vandaag", "Aankomend", "Inbox", "Werk", "Aan mij toegewezen", "Aan anderen toegewezen", "Prioriteit 1", "Prioriteit 2", "Prioriteit 3", "Prioriteit 4", "Bekijk alles", "Geen deadline", "Dringend", "Vandaag en werk", "Donderdag", "Oud project"),
            labels,
        )
        list.performItemClick(null, 12 + list.headerViewsCount, 12) // het filter Dringend; kiezen, en dan Opslaan
        activity.findViewById<View>(R.id.config_save).performClick()
        assertEquals("filter:f-dringend", WidgetConfigStore.get(app, id))
        assertEquals("Dringend", text(view(id), R.id.title))
        assertEquals("2 taken", text(view(id), R.id.subtitle))
        // dezelfde volgorde als in de web-app: eerst op datum, dan prioriteit
        assertEquals(listOf("Boodschappen", "Tandarts bellen"), titles(factory(id)))
    }

    @Test
    fun `meer lijsten - een kop per lijst met de naam uit het filter, een taak mag in twee lijsten`() {
        signIn(withData = data)
        val id = place()
        choose(id, "filter:f-lijsten")
        assertEquals("Vandaag en werk", text(view(id), R.id.title))
        assertEquals("4 taken", text(view(id), R.id.subtitle))
        assertEquals(listOf("# Nu", "Boodschappen", "Tandarts bellen", "# Werk", "Tandarts bellen", "Bakker", "Zonder datum"), titles(factory(id)))
    }

    @Test
    fun `een net afgevinkte taak verdwijnt ook uit een filter`() {
        signIn(withData = data)
        val id = place()
        choose(id, "filter:f-dringend")
        WidgetStore.enqueue(app, QueuedComplete("t1", "tickory-w-t1-00000000", "2026-11-13T14:00", data.accountId, now))
        WidgetUpdater.updateAll(app)
        // zoals in Todoist blijft hij doorgestreept staan tot de server het bevestigt
        assertEquals(listOf("Boodschappen", "Tandarts bellen"), titles(factory(id)))
        val struck = (0 until factory(id).count).map { row(factory(id), it) }.first { it.findViewById<TextView>(R.id.item_title)?.text?.toString() == "Tandarts bellen" }
        assertTrue(struck.findViewById<TextView>(R.id.item_title).paintFlags and android.graphics.Paint.STRIKE_THRU_TEXT_FLAG != 0)
        assertEquals("Tik: weer openzetten", "Weer openzetten: Tandarts bellen", struck.findViewById<View>(R.id.check).contentDescription)
        assertEquals("de titel telt hem niet meer mee", "1 taak", text(view(id), R.id.subtitle))
    }

    @Test
    fun `wat de widget niet kan lezen - een datum in gewone taal, en een naam die niet meer bestaat`() {
        signIn(withData = data)
        val id = place()
        choose(id, "filter:f-donderdag")
        assertEquals("Donderdag", text(view(id), R.id.title))
        assertEquals(View.GONE, view(id).findViewById<View>(R.id.subtitle).visibility)
        val message = text(view(id), R.id.message)
        assertTrue(message, message.startsWith("De widget kan dit deel van het filter niet lezen: donderdag."))
        assertTrue(message, message.contains("7 dagen"))
        assertEquals(0, factory(id).count)

        choose(id, "filter:f-weg")
        assertEquals("Dit filter noemt iets wat niet (meer) bestaat: #Verdwenen", text(view(id), R.id.message))

        choose(id, "filter:f-bestaat-niet")
        assertEquals("Filter", text(view(id), R.id.title))
        assertEquals("Dit filter bestaat niet meer. Kies een ander voor deze widget.", text(view(id), R.id.message))
    }

    @Test
    fun `een filter zonder taken zegt dat`() {
        signIn(withData = data.copy(filters = listOf(WidgetFilter("f-leeg", "Leeg", "p2", "a0"))))
        val id = place()
        choose(id, "filter:f-leeg")
        assertEquals(View.VISIBLE, view(id).findViewById<View>(R.id.empty_state).visibility)
        assertEquals("Geen taken", text(view(id), R.id.empty_title))
    }
}
