package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.pm.PackageManager
import android.view.View
import android.widget.FrameLayout
import android.widget.TextView
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.NoteReminders
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetNote
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.sync.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf

/** De widget Notities op een nagebootst Android: de kop, de kaartjes, de knoppen, en niets zonder aanmelding. */
class NotesWidgetTest : WidgetTestBase() {
    private val manager: AppWidgetManager get() = AppWidgetManager.getInstance(app)

    private fun note(id: String, title: String, excerpt: String = "", pinned: Boolean = false, done: Int = 0, total: Int = 0, shared: Boolean = false, background: String? = null) =
        WidgetNote(id, title, excerpt, background, pinned, "2026-11-13T09:00:00Z", done, total, shared)

    private val notes = listOf(
        note("note-boods-001", "Boodschappen", "✓ brood\n○ melk", pinned = true, done = 1, total = 2, background = "yellow"),
        note("note-texel-001", "Ideeën voor Texel", "Fietsen naar de vuurtoren", shared = true),
        note("note-leeg-0001", "", ""),
    )

    private fun place(): Int = shadowOf(manager).createWidget(NotesWidgetProvider::class.java, R.layout.widget_list)
    private fun view(id: Int): View = shadowOf(manager).getViewFor(id)
    private fun text(view: View, id: Int): String = view.findViewById<TextView>(id).text.toString()
    private fun factory(id: Int): NotesWidgetService.Factory = NotesWidgetService.Factory(app, id).also { it.onDataSetChanged() }
    private fun card(factory: NotesWidgetService.Factory, position: Int): View = factory.getViewAt(position)!!.apply(app, FrameLayout(app))

    @Test
    fun `de kop - Notities met het aantal, en een kaartje per notitie in de volgorde van de gegevens`() {
        signIn(withData = snapshot().copy(notes = notes))
        val id = place()
        WidgetUpdater.updateAll(app)
        val v = view(id)
        assertEquals("Notities", text(v, R.id.title))
        assertEquals("3 notities", text(v, R.id.subtitle))
        assertEquals("Nieuwe notitie", v.findViewById<View>(R.id.add).contentDescription)
        assertEquals(View.VISIBLE, v.findViewById<View>(R.id.list).visibility)

        val f = factory(id)
        assertEquals(3, f.count)
        val first = card(f, 0)
        assertEquals("Boodschappen", text(first, R.id.note_title))
        assertEquals("✓ brood\n○ melk", text(first, R.id.note_excerpt))
        assertEquals("1 van 2 gedaan", text(first, R.id.note_meta))
        assertEquals(View.VISIBLE, first.findViewById<View>(R.id.note_pin).visibility)
        assertEquals("Notitie openen: Boodschappen", first.findViewById<View>(R.id.note_card).contentDescription)
        val second = card(f, 1)
        assertEquals("gedeeld", text(second, R.id.note_meta))
        assertEquals(View.GONE, second.findViewById<View>(R.id.note_pin).visibility)
        val third = card(f, 2)
        assertEquals("Zonder titel", text(third, R.id.note_title))
        assertEquals(View.GONE, third.findViewById<View>(R.id.note_excerpt).visibility)
        assertEquals(View.GONE, third.findViewById<View>(R.id.note_meta).visibility)
    }

    @Test
    fun `een tik opent de notitie in de app, de plus maakt een nieuwe, de kop opent de notities`() {
        signIn(withData = snapshot().copy(notes = notes))
        val id = place()
        WidgetUpdater.updateAll(app)
        val fill = factory(id).fillIn(notes[0])
        assertEquals(WidgetIntents.KIND_OPEN, fill.getStringExtra(WidgetIntents.EXTRA_KIND))
        assertEquals(NoteReminders.taskIdFor("note-boods-001"), fill.getStringExtra(Notifications.EXTRA_TASK_ID))
        assertEquals("note=note-boods-001", DeepLink.task(fill.getStringExtra(Notifications.EXTRA_TASK_ID)))

        val add = shadowOf(NotesWidget.newNote(app)).savedIntent
        // de plus opent het kleine venster Notitie toevoegen, zoals de plus van een takenlijst Taak toevoegen opent
        assertEquals(ComponentName(app, io.github.wnijhof.tickory.quicknote.QuickNoteActivity::class.java), add.component)
        val open = shadowOf(NotesWidget.openNotes(app)).savedIntent
        assertEquals("view=notes", DeepLink.view(open.getStringExtra(DeepLink.EXTRA_VIEW)))
    }

    @Test
    fun `zonder notities een uitleg, zonder aanmelding geen enkele notitie`() {
        signIn(withData = snapshot())
        val id = place()
        WidgetUpdater.updateAll(app)
        assertEquals("Nog geen notities. Tik op + voor een nieuwe.", text(view(id), R.id.message))
        assertEquals(View.GONE, view(id).findViewById<View>(R.id.list).visibility)

        Session.signOut(app)
        WidgetUpdater.updateAll(app)
        assertEquals("Log in in de app", text(view(id), R.id.message))
        assertEquals(0, factory(id).count)
    }

    @Test
    fun `manifest - de widget staat in de lijst van Android, de lijst is alleen door het systeem te binden`() {
        val receivers = app.packageManager.queryBroadcastReceivers(android.content.Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE).setPackage(app.packageName), PackageManager.GET_META_DATA)
        assertTrue(receivers.any { it.activityInfo.name == NotesWidgetProvider::class.java.name })
        val service = app.packageManager.getServiceInfo(ComponentName(app, NotesWidgetService::class.java), 0)
        assertEquals("android.permission.BIND_REMOTEVIEWS", service.permission)
    }
}
