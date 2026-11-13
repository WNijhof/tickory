package io.github.wnijhof.tickory.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Bundle
import android.view.View
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ListView
import android.widget.TextView
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.WidgetFixtures.at
import io.github.wnijhof.tickory.core.WidgetFixtures.project
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.WidgetLabel
import io.github.wnijhof.tickory.core.WidgetRow
import io.github.wnijhof.tickory.core.WidgetSection
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.reminders.Notifications
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** De widgets zoals ze op een nagebootst Android getekend worden: kop, melding, regels, knoppen, configuratiescherm. */
class WidgetUiTest : WidgetTestBase() {
    private val manager: AppWidgetManager get() = AppWidgetManager.getInstance(app)

    private val data = snapshot(
        tasks = listOf(
            task("t1", "2026-11-13T14:00", content = "Tandarts bellen", priority = 1, project = "werk", labels = listOf("l1")),
            task("t2", "2026-11-12", content = "Boodschappen", priority = 3),
            task("t3", "2026-11-14T10:00", content = "Bakker", section = "s1", project = "werk"),
            task("t4", content = "Zonder datum", project = "werk", section = "s1", parent = "t3"),
        ),
        projects = listOf(project("inbox-project", "Inbox"), project("werk", "Werk")),
        sections = listOf(WidgetSection("s1", "werk", "Deze week", false, "a1")),
        labels = listOf(WidgetLabel("l1", "bellen")),
    )

    private fun place(provider: Class<out android.appwidget.AppWidgetProvider>, layout: Int = R.layout.widget_list): Int =
        shadowOf(manager).createWidget(provider, layout)

    private fun view(id: Int): View = shadowOf(manager).getViewFor(id)

    private fun text(view: View, id: Int): String = view.findViewById<TextView>(id).text.toString()

    private fun size(id: Int, width: Int, height: Int) {
        manager.updateAppWidgetOptions(id, Bundle().apply {
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, width)
            putInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, height)
        })
    }

    private fun factory(id: Int): WidgetListService.Factory = WidgetListService.Factory(app, id).also { it.onDataSetChanged() }

    private fun rowView(factory: WidgetListService.Factory, position: Int): View = factory.getViewAt(position)!!.apply(app, FrameLayout(app))

    // ---------- de kop en de meldingen ----------

    @Test
    fun `Vandaag - kop met datum en aantal, en het aantal klopt met de regels`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)

        val v = view(id)
        assertEquals("Vandaag", text(v, R.id.title))
        assertEquals("vr 13 nov · 2 taken", text(v, R.id.subtitle))
        assertEquals(View.VISIBLE, v.findViewById<View>(R.id.list).visibility)
        assertEquals(View.GONE, v.findViewById<View>(R.id.message).visibility)
        assertEquals("Vandaag, 2 taken", v.findViewById<View>(R.id.header_text).contentDescription)
        assertEquals("Taak toevoegen", v.findViewById<View>(R.id.add).contentDescription)
    }

    @Test
    fun `een taak is enkelvoud - 1 taak`() {
        signIn(withData = snapshot(listOf(task("a", "2026-11-13"))))
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        assertEquals("vr 13 nov · 1 taak", text(view(id), R.id.subtitle))
    }

    @Test
    fun `lege staat per soort lijst`() {
        signIn(withData = snapshot())
        val today = place(TodayWidgetProvider::class.java)
        val upcoming = place(UpcomingWidgetProvider::class.java)
        val projectWidget = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, projectWidget, "inbox")
        WidgetUpdater.updateAll(app)

        assertEquals("Niets te doen vandaag", text(view(today), R.id.message))
        assertEquals(View.GONE, view(today).findViewById<View>(R.id.list).visibility)
        assertEquals("Niets gepland de komende twee weken", text(view(upcoming), R.id.message))
        assertEquals("Geen open taken", text(view(projectWidget), R.id.message))
        assertEquals("Inbox", text(view(projectWidget), R.id.title))
    }

    @Test
    fun `zonder aanmelding - Log in in de app - en geen taak te zien`() {
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        val v = view(id)
        assertEquals("Log in in de app", text(v, R.id.message))
        assertEquals(View.VISIBLE, v.findViewById<View>(R.id.message).visibility)
        assertEquals(View.GONE, v.findViewById<View>(R.id.list).visibility)
        assertEquals(View.GONE, v.findViewById<View>(R.id.subtitle).visibility)
    }

    @Test
    fun `verlopen aanmelding, laden, en geen gegevens van een vorige gebruiker na afmelden of wisselen`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        assertEquals("vr 13 nov · 2 taken", text(view(id), R.id.subtitle))

        Session.markExpired(app)
        assertEquals("Log opnieuw in in de app", text(view(id), R.id.message))
        assertFalse("geen taken meer in beeld", factory(id).count > 0)

        Session.set(app, token) // opnieuw ingelogd: dezelfde gebruiker
        assertEquals("vr 13 nov · 2 taken", text(view(id), R.id.subtitle))

        Session.set(app, "tky_een-andere-gebruiker_0123456789-ABCDEF")
        assertEquals("Bezig met laden…", text(view(id), R.id.message))
        assertEquals("een andere gebruiker ziet de taken van de vorige niet", 0, factory(id).count)

        WidgetStore.accept(app, data)
        Session.signOut(app)
        assertEquals("Log in in de app", text(view(id), R.id.message))
        assertEquals(0, factory(id).count)
    }

    @Test
    fun `een project dat weg is, en een filter dat nog niet kan, geven een uitleg`() {
        signIn(withData = data)
        val id = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, id, "project:bestaat-niet")
        WidgetUpdater.updateAll(app)
        assertEquals("Dit project is er niet meer. Kies een ander project.", text(view(id), R.id.message))
        assertEquals(View.GONE, view(id).findViewById<View>(R.id.subtitle).visibility)

        WidgetConfigStore.set(app, id, "filter:f-1")
        WidgetUpdater.updateAll(app)
        assertEquals("Filters kunnen nog niet in een widget. Kies een project.", text(view(id), R.id.message))
    }

    @Test
    fun `Project of lijst - toont het gekozen project`() {
        signIn(withData = data)
        val id = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, id, "project:werk")
        WidgetUpdater.updateAll(app)
        val v = view(id)
        assertEquals("Werk", text(v, R.id.title))
        assertEquals("3 taken", text(v, R.id.subtitle))
        val f = factory(id)
        assertEquals("een taak, een kop voor de sectie, en twee taken", 4, f.count)
        assertEquals("Deze week", text(rowView(f, 1), R.id.header_label))
    }

    // ---------- de formaten ----------

    @Test
    fun `klein - geen ondertitel, het aantal naast de titel, geen tweede regel in de lijst`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        size(id, 110, 110)
        WidgetUpdater.updateAll(app)
        val v = view(id)
        assertEquals("Vandaag · 2", text(v, R.id.title))
        assertEquals(View.GONE, v.findViewById<View>(R.id.subtitle).visibility)
        assertEquals(View.GONE, rowView(factory(id), 0).findViewById<View>(R.id.item_line2).visibility)
    }

    @Test
    fun `middel en groot - ondertitel en tweede regel, groot met grotere letters`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        size(id, 250, 250)
        WidgetUpdater.updateAll(app)
        assertEquals("Vandaag", text(view(id), R.id.title))
        val medium = rowView(factory(id), 0)
        assertEquals(View.VISIBLE, medium.findViewById<View>(R.id.item_line2).visibility)
        val mediumSize = medium.findViewById<TextView>(R.id.item_title).textSize

        size(id, 320, 450)
        WidgetUpdater.updateAll(app)
        val large = rowView(factory(id), 0)
        assertTrue(large.findViewById<TextView>(R.id.item_title).textSize > mediumSize)
        assertTrue(view(id).findViewById<TextView>(R.id.title).textSize > 0)
    }

    @Test
    fun `een formaatwijziging tekent de widget opnieuw`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        assertEquals("Vandaag", text(view(id), R.id.title))
        size(id, 100, 100)
        TodayWidgetProvider().onAppWidgetOptionsChanged(app, manager, id, manager.getAppWidgetOptions(id))
        assertEquals("Vandaag · 2", text(view(id), R.id.title))
    }

    // ---------- de regels ----------

    @Test
    fun `een regel - titel, datum, project, prioriteitskleur en omschrijvingen voor TalkBack`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        val f = factory(id)
        assertEquals(2, f.count)

        // te laat komt eerst
        val overdue = rowView(f, 0)
        assertEquals("Boodschappen", text(overdue, R.id.item_title))
        assertEquals("gisteren · ", text(overdue, R.id.item_due)) // zonder project in de naam "Inbox"? het project staat erachter
        assertEquals("Inbox", text(overdue, R.id.item_meta))
        assertEquals(app.getColor(R.color.widget_overdue), overdue.findViewById<TextView>(R.id.item_due).currentTextColor)
        assertEquals("Voltooien: Boodschappen", overdue.findViewById<View>(R.id.check).contentDescription)
        assertEquals("Taak openen: Boodschappen", overdue.findViewById<View>(R.id.text_area).contentDescription)

        val today = rowView(f, 1)
        assertEquals("Tandarts bellen", text(today, R.id.item_title))
        assertEquals("14:00 · ", text(today, R.id.item_due))
        assertEquals("Werk · @bellen", text(today, R.id.item_meta))
        assertEquals(app.getColor(R.color.widget_text_soft), today.findViewById<TextView>(R.id.item_due).currentTextColor)

        // de cirkel heeft de kleur van de prioriteit
        assertNotNull(rowView(f, 1).findViewById<ImageView>(R.id.check).drawable)
        assertEquals(R.drawable.widget_check_p1, WidgetListService.Factory.checkIcon(1))
        assertEquals(R.drawable.widget_check_p2, WidgetListService.Factory.checkIcon(2))
        assertEquals(R.drawable.widget_check_p3, WidgetListService.Factory.checkIcon(3))
        assertEquals(R.drawable.widget_check_p4, WidgetListService.Factory.checkIcon(4))
        assertEquals("iets onmogelijks is geen prioriteit", R.drawable.widget_check_p4, WidgetListService.Factory.checkIcon(0))
        assertEquals(R.drawable.widget_check_p4, WidgetListService.Factory.checkIcon(9))
    }

    @Test
    fun `een taak zonder titel krijgt een naam, en de twee tikvlakken doen afvinken en openen`() {
        signIn(withData = snapshot(listOf(task("leeg", "2026-11-13", content = ""))))
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        val f = factory(id)
        assertEquals("Taak zonder titel", text(rowView(f, 0), R.id.item_title))

        val row = WidgetRow.Item("leeg", "", 4, null, false, 0, null)
        val (complete, open) = f.clickIntents(row)
        assertEquals(WidgetIntents.KIND_COMPLETE, complete.getStringExtra(WidgetIntents.EXTRA_KIND))
        assertEquals("leeg", complete.getStringExtra(Notifications.EXTRA_TASK_ID))
        assertEquals(WidgetIntents.KIND_OPEN, open.getStringExtra(WidgetIntents.EXTRA_KIND))
        assertEquals("leeg", open.getStringExtra(Notifications.EXTRA_TASK_ID))
    }

    @Test
    fun `subtaken springen in`() {
        signIn(withData = data)
        val id = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, id, "project:werk")
        WidgetUpdater.updateAll(app)
        val f = factory(id)
        val parent = rowView(f, 2) // na de kop van de sectie: "Bakker", dan zijn subtaak
        val child = rowView(f, 3)
        assertEquals("Bakker", text(parent, R.id.item_title))
        assertEquals("Zonder datum", text(child, R.id.item_title))
        assertTrue(child.findViewById<View>(R.id.item_root).paddingLeft > parent.findViewById<View>(R.id.item_root).paddingLeft)
    }

    @Test
    fun `Binnenkort - dagkoppen en tijden`() {
        signIn(withData = data)
        val id = place(UpcomingWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        val f = factory(id)
        assertEquals("Morgen", text(rowView(f, 0), R.id.header_label))
        assertEquals("Bakker", text(rowView(f, 1), R.id.item_title))
        assertEquals("10:00 · ", text(rowView(f, 1), R.id.item_due))
        assertEquals("1 taak", text(view(id), R.id.subtitle))
        assertEquals(2, f.count)
    }

    @Test
    fun `de lijst heeft stabiele id's en twee soorten regels`() {
        signIn(withData = data)
        val id = place(UpcomingWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        val f = factory(id)
        assertEquals(2, f.viewTypeCount)
        assertTrue(f.hasStableIds())
        assertEquals(f.getItemId(1), factory(id).getItemId(1))
        assertNull(f.loadingView)
        assertNull("buiten de lijst", f.getViewAt(99))
        // een widget die niet bestaat (id weg) geeft een lege lijst
        assertEquals(0, WidgetListService.Factory(app, AppWidgetManager.INVALID_APPWIDGET_ID).also { it.onDataSetChanged() }.count)
    }

    // ---------- de knoppen ----------

    @Test
    fun `de plusknop opent Taak toevoegen in het project van de lijst`() {
        signIn(withData = data)
        val today = place(TodayWidgetProvider::class.java)
        val upcoming = place(UpcomingWidgetProvider::class.java)
        val projectWidget = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, projectWidget, "project:werk")
        val inboxWidget = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, inboxWidget, "inbox")
        WidgetUpdater.updateAll(app)

        fun target(id: Int): String? {
            view(id).findViewById<View>(R.id.add).performClick()
            val started = shadowOf(app).nextStartedActivity
            assertEquals(MainActivity::class.java.name, started.component!!.className)
            assertTrue(started.hasExtra(DeepLink.EXTRA_ADD))
            return started.getStringExtra(DeepLink.EXTRA_ADD)
        }
        assertEquals("today", target(today))
        assertEquals("", target(upcoming))
        assertEquals("werk", target(projectWidget))
        assertEquals("inbox-project", target(inboxWidget))
    }

    @Test
    fun `de kop opent de app`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        view(id).findViewById<View>(R.id.header_text).performClick()
        assertEquals(MainActivity::class.java.name, shadowOf(app).nextStartedActivity.component!!.className)
        // en de melding "Log in in de app" ook
        Session.signOut(app)
        view(id).findViewById<View>(R.id.message).performClick()
        assertEquals(MainActivity::class.java.name, shadowOf(app).nextStartedActivity.component!!.className)
    }

    @Test
    fun `de knop Taak toevoegen - Inbox, en alleen een plusteken als hij smal is`() {
        signIn(withData = data)
        val id = place(AddWidgetProvider::class.java, R.layout.widget_add)
        WidgetUpdater.updateAll(app)
        val v = view(id)
        assertEquals("Taak toevoegen", v.findViewById<View>(R.id.add_root).contentDescription)
        v.findViewById<View>(R.id.add_root).performClick()
        val started = shadowOf(app).nextStartedActivity
        assertEquals("inbox-project", started.getStringExtra(DeepLink.EXTRA_ADD))

        assertEquals(View.VISIBLE, view(id).findViewById<View>(R.id.add_label).visibility)
        size(id, 60, 60)
        WidgetUpdater.updateAll(app)
        assertEquals(View.GONE, view(id).findViewById<View>(R.id.add_label).visibility)
        size(id, 160, 60)
        AddWidgetProvider().onAppWidgetOptionsChanged(app, manager, id, null)
        assertEquals(View.VISIBLE, view(id).findViewById<View>(R.id.add_label).visibility)
    }

    @Test
    fun `de knop Taak toevoegen werkt ook zonder aanmelding - dan zonder doel`() {
        val id = place(AddWidgetProvider::class.java, R.layout.widget_add)
        WidgetUpdater.updateAll(app)
        view(id).findViewById<View>(R.id.add_root).performClick()
        val started = shadowOf(app).nextStartedActivity
        assertTrue(started.hasExtra(DeepLink.EXTRA_ADD))
        assertEquals("", started.getStringExtra(DeepLink.EXTRA_ADD))
    }

    // ---------- tik op een regel ----------

    private fun tap(kind: String?, taskId: String?): WidgetActionActivity {
        val intent = Intent(app, WidgetActionActivity::class.java)
        if (kind != null) intent.putExtra(WidgetIntents.EXTRA_KIND, kind)
        if (taskId != null) intent.putExtra(Notifications.EXTRA_TASK_ID, taskId)
        val controller = Robolectric.buildActivity(WidgetActionActivity::class.java, intent).create()
        return controller.get()
    }

    @Test
    fun `tik op de cirkel - afvinken, en het scherm sluit meteen`() {
        signIn(withData = data)
        val activity = tap(WidgetIntents.KIND_COMPLETE, "t2")
        assertTrue(activity.isFinishing)
        assertEquals(listOf("t2"), WidgetStore.queue(app).map { it.taskId })
        assertNull("er wordt geen scherm gestart", shadowOf(app).nextStartedActivity)
    }

    @Test
    fun `tik op de titel - de taak openen in de app`() {
        signIn(withData = data)
        val activity = tap(WidgetIntents.KIND_OPEN, "t2")
        assertTrue(activity.isFinishing)
        val started = shadowOf(app).nextStartedActivity
        assertEquals(MainActivity::class.java.name, started.component!!.className)
        assertEquals("t2", started.getStringExtra(Notifications.EXTRA_TASK_ID))
        assertTrue("niets afgevinkt", WidgetStore.queue(app).isEmpty())
    }

    @Test
    fun `een tik met onzin doet niets`() {
        signIn(withData = data)
        for ((kind, id) in listOf(null to "t2", "verwijderen" to "t2", WidgetIntents.KIND_COMPLETE to null, WidgetIntents.KIND_COMPLETE to "x';alert(1);'", WidgetIntents.KIND_OPEN to "a b")) {
            assertTrue(tap(kind, id).isFinishing)
        }
        assertTrue(WidgetStore.queue(app).isEmpty())
        assertNull(shadowOf(app).nextStartedActivity)
    }

    // ---------- de intenties ----------

    @Test
    fun `intenties - expliciet, onveranderlijk behalve het sjabloon van de lijst`() {
        val open = WidgetIntents.openApp(app)
        val add = WidgetIntents.addTask(app, "werk")
        val template = WidgetIntents.itemTemplate(app, 12)
        for (pi in listOf(open, add, template)) {
            val intent = shadowOf(pi).savedIntent
            assertNotNull("expliciet: " + intent, intent.component)
            assertEquals(app.packageName, intent.component!!.packageName)
        }
        assertTrue(shadowOf(open).flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertTrue(shadowOf(add).flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertTrue("het sjabloon moet aanvulbaar zijn", shadowOf(template).flags and PendingIntent.FLAG_MUTABLE != 0)
        assertFalse(shadowOf(template).flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertEquals(WidgetActionActivity::class.java.name, shadowOf(template).savedIntent.component!!.className)
        // elk doel een eigen intentie
        assertTrue(WidgetIntents.addTask(app, "a") != WidgetIntents.addTask(app, "b"))
    }

    @Test
    fun `manifest - alleen wat moet is exporteerbaar, de lijst alleen voor Android zelf`() {
        val pm = app.packageManager
        for (cls in listOf(TodayWidgetProvider::class.java, UpcomingWidgetProvider::class.java, ProjectWidgetProvider::class.java, AddWidgetProvider::class.java, WidgetTickReceiver::class.java)) {
            assertFalse(cls.simpleName, pm.getReceiverInfo(ComponentName(app, cls), 0).exported)
        }
        val service = pm.getServiceInfo(ComponentName(app, WidgetListService::class.java), PackageManager.GET_META_DATA)
        assertFalse(service.exported)
        assertEquals("android.permission.BIND_REMOTEVIEWS", service.permission)
        assertFalse(pm.getActivityInfo(ComponentName(app, WidgetActionActivity::class.java), 0).exported)
        assertTrue("Android moet het configuratiescherm kunnen starten", pm.getActivityInfo(ComponentName(app, WidgetConfigActivity::class.java), 0).exported)
        // de vier widgets hebben elk een beschrijving voor Android
        for (cls in listOf(TodayWidgetProvider::class.java, UpcomingWidgetProvider::class.java, ProjectWidgetProvider::class.java, AddWidgetProvider::class.java)) {
            val info = pm.getReceiverInfo(ComponentName(app, cls), PackageManager.GET_META_DATA)
            assertTrue(cls.simpleName, info.metaData.getInt("android.appwidget.provider") != 0)
        }
    }

    // ---------- het middernachtalarm ----------

    @Test
    fun `middernacht - een alarm per dag zolang er een widget staat, ook rond de wintertijd`() {
        assertEquals(at("2026-11-14T00:00:30"), WidgetClock.nextMidnightMs(at("2026-11-13T09:00")))
        assertEquals(at("2026-11-14T00:00:30"), WidgetClock.nextMidnightMs(at("2026-11-13T23:59:59")))
        // de dag van de wintertijd duurt 25 uur
        assertEquals(at("2026-10-25T00:00:30"), WidgetClock.nextMidnightMs(at("2026-10-24T12:00")))
        assertEquals(at("2026-10-26T00:00:30"), WidgetClock.nextMidnightMs(at("2026-10-25T12:00")))
        // de dag van de zomertijd duurt 23 uur
        assertEquals(at("2026-03-29T00:00:30"), WidgetClock.nextMidnightMs(at("2026-03-28T12:00")))
        assertEquals(at("2026-03-30T00:00:30"), WidgetClock.nextMidnightMs(at("2026-03-29T12:00")))

        val alarms = shadowOf(app.getSystemService(AlarmManager::class.java))
        signIn(withData = data)
        assertTrue(alarms.scheduledAlarms.isEmpty())
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        assertEquals(1, alarms.scheduledAlarms.size)
        assertEquals(at("2026-11-14T00:00:30"), alarms.scheduledAlarms.single().triggerAtTime)
        WidgetUpdater.updateAll(app)
        assertEquals("opnieuw zetten vervangt het alarm", 1, alarms.scheduledAlarms.size)

        // na middernacht: een nieuwe dag
        now = at("2026-11-14T00:01")
        WidgetTickReceiver().onReceive(app, Intent())
        assertEquals("za 14 nov · 3 taken", text(view(id), R.id.subtitle))
        assertEquals(at("2026-11-15T00:00:30"), alarms.scheduledAlarms.single().triggerAtTime)

        WidgetClock.cancel(app)
        assertTrue(alarms.scheduledAlarms.isEmpty())
    }

    @Test
    fun `zonder widgets blijft er geen alarm staan`() {
        val alarms = shadowOf(app.getSystemService(AlarmManager::class.java))
        WidgetClock.scheduleMidnight(app) // een alarm van een widget die intussen is weggehaald
        assertEquals(1, alarms.scheduledAlarms.size)
        WidgetUpdater.updateAll(app)
        assertTrue(alarms.scheduledAlarms.isEmpty())
    }

    @Test
    fun `een nieuwe dag - te laat en vandaag schuiven mee, ook zonder verbinding`() {
        signIn(withData = snapshot(listOf(task("a", "2026-11-13", content = "Vandaag"), task("b", "2026-11-14", content = "Morgen"))))
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        assertEquals(listOf("Vandaag"), (0 until factory(id).count).map { text(rowView(factory(id), it), R.id.item_title) })
        now = at("2026-11-14T00:05")
        WidgetUpdater.updateAll(app)
        val f = factory(id)
        assertEquals(listOf("Vandaag", "Morgen"), (0 until f.count).map { text(rowView(f, it), R.id.item_title) })
        assertEquals("gisteren · ", text(rowView(f, 0), R.id.item_due))
        assertEquals(app.getColor(R.color.widget_overdue), rowView(f, 0).findViewById<TextView>(R.id.item_due).currentTextColor)
        assertEquals("", text(rowView(f, 1), R.id.item_due))
    }

    // ---------- het configuratiescherm ----------

    private fun configIntent(id: Int) = Intent(app, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id)

    @Test
    fun `configuratie - kies een project, het wordt bewaard en de widget wordt getekend`() {
        signIn(withData = data)
        val id = place(ProjectWidgetProvider::class.java)
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, configIntent(id)).setup().get()

        val list = activity.findViewById<ListView>(R.id.config_list)
        val labels = (0 until list.adapter.count).map { (list.adapter.getView(it, null, list) as TextView).text.toString() }
        assertEquals(listOf("Vandaag", "Binnenkort", "Inbox", "Werk"), labels)
        assertEquals(View.GONE, activity.findViewById<View>(R.id.config_hint).visibility)

        list.performItemClick(null, 3, 3)

        assertTrue(activity.isFinishing)
        assertEquals(android.app.Activity.RESULT_OK, shadowOf(activity).resultCode)
        assertEquals(id, shadowOf(activity).resultIntent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, -1))
        assertEquals("project:werk", WidgetConfigStore.get(app, id))
        assertEquals("Werk", text(view(id), R.id.title))
    }

    @Test
    fun `configuratie - sluiten zonder te kiezen plaatst de widget niet`() {
        signIn(withData = data)
        val id = place(ProjectWidgetProvider::class.java)
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, configIntent(id)).setup().get()
        assertEquals(android.app.Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
        assertNull(WidgetConfigStore.get(app, id))
    }

    @Test
    fun `configuratie - subprojecten springen in en gearchiveerde ontbreken`() {
        val s = snapshot(
            projects = listOf(
                project("inbox-project", "Inbox"), project("a", "Alfa", order = "a1"), project("a1", "Alfa-sub", parent = "a"),
                project("z", "Oud", archived = true),
            ),
        )
        signIn(withData = s)
        val id = place(ProjectWidgetProvider::class.java)
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, configIntent(id)).setup().get()
        val list = activity.findViewById<ListView>(R.id.config_list)
        val rows = (0 until list.adapter.count).map { list.adapter.getView(it, null, list) as TextView }
        assertEquals(listOf("Vandaag", "Binnenkort", "Inbox", "Alfa", "Alfa-sub"), rows.map { it.text.toString() })
        assertTrue(rows[4].paddingLeft > rows[3].paddingLeft)
        assertTrue("minstens 48dp hoog om te tikken", rows[3].minHeight >= (48 * app.resources.displayMetrics.density).toInt())
    }

    @Test
    fun `configuratie - zonder aanmelding de vaste keuzes en een uitleg met een knop om de app te openen`() {
        val id = place(ProjectWidgetProvider::class.java)
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, configIntent(id)).setup().get()
        val list = activity.findViewById<ListView>(R.id.config_list)
        assertEquals(3, list.adapter.count)
        assertEquals(View.VISIBLE, activity.findViewById<View>(R.id.config_hint).visibility)
        activity.findViewById<View>(R.id.config_open_app).performClick()
        assertEquals(MainActivity::class.java.name, shadowOf(activity).nextStartedActivity.component!!.className)
        list.performItemClick(null, 0, 0)
        assertEquals("today", WidgetConfigStore.get(app, id))
    }

    @Test
    fun `configuratie - geen projecten van een vorige gebruiker zolang niet vaststaat van wie de gegevens zijn`() {
        signIn(withData = data)
        Session.set(app, "tky_een-andere-gebruiker_0123456789-ABCDEF")
        val id = place(ProjectWidgetProvider::class.java)
        val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, configIntent(id)).setup().get()
        assertEquals(3, activity.findViewById<ListView>(R.id.config_list).adapter.count)
    }

    @Test
    fun `configuratie - een widget-id dat niet van ons is, of ontbreekt, sluit het scherm zonder iets te bewaren`() {
        signIn(withData = data)
        val other = place(TodayWidgetProvider::class.java) // een ander soort widget
        for (intent in listOf(configIntent(9999), configIntent(other), Intent(app, WidgetConfigActivity::class.java), configIntent(AppWidgetManager.INVALID_APPWIDGET_ID))) {
            val activity = Robolectric.buildActivity(WidgetConfigActivity::class.java, intent).setup().get()
            assertTrue(activity.isFinishing)
            assertEquals(android.app.Activity.RESULT_CANCELED, shadowOf(activity).resultCode)
        }
        assertNull(WidgetConfigStore.get(app, 9999))
    }

    @Test
    fun `een widget die verdwijnt, vergeet zijn keuze`() {
        signIn(withData = data)
        val id = place(ProjectWidgetProvider::class.java)
        WidgetConfigStore.set(app, id, "project:werk")
        ProjectWidgetProvider().onDeleted(app, intArrayOf(id))
        assertNull(WidgetConfigStore.get(app, id))
    }

    @Test
    fun `de eerste widget zorgt dat er gegevens komen, en zonder aanmelding gebeurt er niets`() {
        val work = androidx.work.WorkManager.getInstance(app)
        TodayWidgetProvider().onEnabled(app)
        assertTrue(work.getWorkInfosForUniqueWork("tickory-sync-now").get().isEmpty())
        signIn()
        TodayWidgetProvider().onEnabled(app)
        assertFalse(work.getWorkInfosForUniqueWork("tickory-sync-now").get().isEmpty())
    }

    // ---------- kleuren ----------

    private fun luminance(color: Int): Double {
        fun channel(v: Int): Double = (v / 255.0).let { if (it <= 0.03928) it / 12.92 else Math.pow((it + 0.055) / 1.055, 2.4) }
        return 0.2126 * channel(android.graphics.Color.red(color)) + 0.7152 * channel(android.graphics.Color.green(color)) + 0.0722 * channel(android.graphics.Color.blue(color))
    }

    private fun contrast(a: Int, b: Int): Double {
        val (hi, lo) = luminance(a).let { la -> luminance(b).let { lb -> if (la > lb) la to lb else lb to la } }
        return (hi + 0.05) / (lo + 0.05)
    }

    @Test
    fun `kleuren - op Android 12 en nieuwer volgen ze het thema van de gebruiker en blijven ze leesbaar`() {
        val bg = app.getColor(R.color.widget_bg)
        assertEquals("het thema van het systeem (neutral1_10), niet het vaste wit", app.getColor(android.R.color.system_neutral1_10), bg)
        assertEquals(app.getColor(android.R.color.system_accent1_600), app.getColor(R.color.widget_accent))
        assertTrue(contrast(app.getColor(R.color.widget_text), bg) >= 4.5)
        assertTrue(contrast(app.getColor(R.color.widget_text_soft), bg) >= 4.5)
        assertTrue(contrast(app.getColor(R.color.widget_accent), bg) >= 3.0)
        assertTrue(contrast(app.getColor(R.color.widget_overdue), bg) >= 4.5)
        // de prioriteitskleuren blijven vast: ze betekenen iets
        assertEquals(0xFFD1453B.toInt(), app.getColor(R.color.widget_p1))
    }

    @Test
    @Config(qualifiers = "nl-night")
    fun `kleuren - donker volgt het systeem`() {
        val bg = app.getColor(R.color.widget_bg)
        assertEquals(app.getColor(android.R.color.system_neutral1_900), bg)
        assertEquals(app.getColor(android.R.color.system_accent1_200), app.getColor(R.color.widget_accent))
        assertTrue(luminance(bg) < 0.1)
        assertTrue(contrast(app.getColor(R.color.widget_text), bg) >= 4.5)
        assertTrue(contrast(app.getColor(R.color.widget_text_soft), bg) >= 4.5)
        assertEquals("vaste prioriteitskleur, lichter in het donker", 0xFFF2776C.toInt(), app.getColor(R.color.widget_p1))
        assertTrue(contrast(app.getColor(R.color.widget_overdue), bg) >= 4.5)
    }

    @Test
    fun `kleuren - de terugval zonder dynamische kleuren is leesbaar in licht en donker`() {
        fun colors(file: String): Map<String, Int> {
            val text = java.io.File(file).readText()
            return Regex("""<color name="(\w+)">(#[0-9A-Fa-f]{6,8})</color>""").findAll(text).associate { it.groupValues[1] to android.graphics.Color.parseColor(it.groupValues[2]) }
        }
        for (file in listOf("src/main/res/values/widget_colors.xml", "src/main/res/values-night/widget_colors.xml")) {
            val c = colors(file)
            assertTrue(file, contrast(c.getValue("widget_text"), c.getValue("widget_bg")) >= 4.5)
            assertTrue(file, contrast(c.getValue("widget_text_soft"), c.getValue("widget_bg")) >= 4.5)
            assertTrue(file, contrast(c.getValue("widget_accent"), c.getValue("widget_bg")) >= 3.0)
            assertTrue(file, contrast(c.getValue("widget_overdue"), c.getValue("widget_bg")) >= 4.5)
            for (p in 1..4) assertTrue("$file p$p", contrast(c.getValue("widget_p$p"), c.getValue("widget_bg")) >= 3.0)
        }
    }

    @Test
    @Config(qualifiers = "en")
    fun `Engels - kop, melding en omschrijvingen`() {
        signIn(withData = data)
        val id = place(TodayWidgetProvider::class.java)
        WidgetUpdater.updateAll(app)
        assertEquals("Today", text(view(id), R.id.title))
        assertEquals("Fri 13 Nov · 2 tasks", text(view(id), R.id.subtitle))
        assertEquals("Add task", view(id).findViewById<View>(R.id.add).contentDescription)
        val row = rowView(factory(id), 0)
        assertEquals("Complete: Boodschappen", row.findViewById<View>(R.id.check).contentDescription)
        assertEquals("Open task: Boodschappen", row.findViewById<View>(R.id.text_area).contentDescription)
        assertEquals("yesterday · ", text(row, R.id.item_due))
        Session.signOut(app)
        assertEquals("Sign in via the app", text(view(id), R.id.message))
    }
}
