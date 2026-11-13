package io.github.wnijhof.tickory.widget

import android.app.AlarmManager
import androidx.work.WorkInfo
import androidx.work.WorkManager
import io.github.wnijhof.tickory.core.ReminderInfo
import io.github.wnijhof.tickory.core.SyncSnapshot
import io.github.wnijhof.tickory.core.TaskInfo
import io.github.wnijhof.tickory.core.WidgetFixtures.at
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.reminders.ReminderEngine
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.ReminderStore
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import org.robolectric.shadows.ShadowAlarmManager

/** Afvinken vanuit een widget: lokaal en meteen, ook zonder internet; de rest gaat via de wachtrij. */
class WidgetActionsTest : WidgetTestBase() {
    private val data = snapshot(
        listOf(
            task("gewoon", "2026-11-13", content = "Gewone taak"),
            task("kind", "2026-11-13", parent = "gewoon"),
            task("terug", "2026-11-13T14:00", recurring = true, content = "Planten water geven"),
            task("terugkind", "2026-11-13", parent = "terug"),
            task("andere", "2026-11-13"),
        ),
    )

    private fun visible(): List<String> =
        ((WidgetModel.state(app, WidgetSource.Today) as WidgetModel.State.Ready).content.rows.filterIsInstance<io.github.wnijhof.tickory.core.WidgetRow.Item>()).map { it.id }.sorted()

    @Test
    fun `afvinken zet de taak in de wachtrij en haalt hem meteen uit de widget - zonder internet`() {
        signIn(withData = data)
        assertEquals(listOf("andere", "gewoon", "kind", "terug", "terugkind"), visible())

        assertEquals(WidgetActions.Result.QUEUED, WidgetActions.complete(app, "gewoon"))

        assertEquals("de taak en zijn subtaak zijn weg", listOf("andere", "terug", "terugkind"), visible())
        val item = WidgetStore.queue(app).single()
        assertEquals("gewoon", item.taskId)
        assertEquals("user-anna-0001", item.accountId)
        assertNull("een gewone taak heeft geen if_due", item.ifDue)
        assertTrue(item.uuid.startsWith("tickory-w-"))
        assertEquals(now, item.queuedAtMs)
        // er is niets uit het netwerk gekomen: de bewaarde gegevens zijn niet aangeraakt
        assertEquals(data, WidgetStore.snapshot(app))
    }

    @Test
    fun `dubbel tikken geeft een actie met een uuid`() {
        signIn(withData = data)
        assertEquals(WidgetActions.Result.QUEUED, WidgetActions.complete(app, "gewoon"))
        val uuid = WidgetStore.queue(app).single().uuid
        assertEquals(WidgetActions.Result.ALREADY_QUEUED, WidgetActions.complete(app, "gewoon"))
        assertEquals(1, WidgetStore.queue(app).size)
        assertEquals(uuid, WidgetStore.queue(app).single().uuid)
    }

    @Test
    fun `een terugkerende taak - de gezien datum gaat mee, de taak wacht verborgen op de server, de subtaken blijven`() {
        signIn(withData = data)
        assertEquals(WidgetActions.Result.QUEUED, WidgetActions.complete(app, "terug"))
        assertEquals("2026-11-13T14:00", WidgetStore.queue(app).single().ifDue)
        assertEquals(listOf("andere", "gewoon", "kind", "terugkind"), visible())
        // er wordt niets verzonnen: de bewaarde taak heeft nog dezelfde datum (de volgende komt van de server)
        assertEquals("2026-11-13T14:00", WidgetStore.snapshot(app)!!.tasks.first { it.id == "terug" }.due)
    }

    @Test
    fun `niet aangemeld, verlopen, ongecontroleerd of een onbekende taak - er gebeurt niets`() {
        // niet aangemeld
        assertEquals(WidgetActions.Result.IGNORED, WidgetActions.complete(app, "gewoon"))
        signIn(withData = data)
        // onbruikbare id's
        for (bad in listOf(null, "", "a b", "x';alert(1);'", "../x", "a".repeat(65))) assertEquals("'$bad'", WidgetActions.Result.IGNORED, WidgetActions.complete(app, bad))
        // een taak die niet in de gegevens staat (de widget liep achter)
        assertEquals(WidgetActions.Result.IGNORED, WidgetActions.complete(app, "bestaat-niet"))
        assertEquals(emptyList<Any>(), WidgetStore.queue(app))
        // ongecontroleerd (net opnieuw ingelogd)
        WidgetStore.markUnverified(app)
        assertEquals(WidgetActions.Result.IGNORED, WidgetActions.complete(app, "gewoon"))
        WidgetStore.accept(app, data)
        // verlopen aanmelding
        Session.markExpired(app)
        assertEquals(WidgetActions.Result.IGNORED, WidgetActions.complete(app, "gewoon"))
        assertEquals(emptyList<Any>(), WidgetStore.queue(app))
        assertTrue(Prefs(app).sessionExpired)
    }

    @Test
    fun `afvinken plant de verversing met netwerkvoorwaarde in`() {
        signIn(withData = data)
        WidgetActions.complete(app, "andere")
        val work = WorkManager.getInstance(app).getWorkInfosForUniqueWork("tickory-sync-now").get()
        assertTrue(work.any { it.state == WorkInfo.State.ENQUEUED })
    }

    @Test
    fun `herinneringen van een afgevinkte taak vervallen meteen - alarm, uitstel en melding`() {
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
        signIn(withData = data)
        val alarms = shadowOf(app.getSystemService(AlarmManager::class.java))
        // de taak van 14:00 heeft een herinnering om 13:30; er is ook een voor een andere taak
        val tasks = listOf(TaskInfo("terug", "Planten water geven", "2026-11-13T14:00"), TaskInfo("andere", "Andere", "2026-11-13T16:00"))
        val reminders = listOf(ReminderInfo("rem-terug", "terug", "relative", 30, null), ReminderInfo("rem-andere", "andere", "relative", 30, null))
        ReminderEngine.onSynced(app, SyncSnapshot(tasks, reminders))
        assertEquals(2, alarms.scheduledAlarms.size)

        WidgetActions.complete(app, "terug")

        assertEquals("alleen het alarm van de andere taak blijft", 1, alarms.scheduledAlarms.size)
        assertEquals(setOf("rem-andere"), ReminderStore.load(app).scheduled.keys)
        // als de server het alsnog anders ziet (bijvoorbeeld geweigerd), komt de herinnering bij de verversing terug
        ReminderEngine.onSynced(app, SyncSnapshot(tasks, reminders))
        assertEquals(setOf("rem-terug", "rem-andere"), ReminderStore.load(app).scheduled.keys)
    }

    @Test
    fun `de widgets worden opnieuw getekend - de lijst verandert zonder dat de launcher iets doet`() {
        signIn(withData = data)
        val manager = android.appwidget.AppWidgetManager.getInstance(app)
        val id = shadowOf(manager).createWidget(TodayWidgetProvider::class.java, io.github.wnijhof.tickory.R.layout.widget_list)
        WidgetUpdater.updateAll(app)
        val before = shadowOf(manager).getViewFor(id)
        assertEquals("5 taken", before.findViewById<android.widget.TextView>(io.github.wnijhof.tickory.R.id.subtitle).text.toString().substringAfter(" · "))

        WidgetActions.complete(app, "gewoon")

        val after = shadowOf(manager).getViewFor(id)
        assertEquals("3 taken", after.findViewById<android.widget.TextView>(io.github.wnijhof.tickory.R.id.subtitle).text.toString().substringAfter(" · "))
    }

    @Test
    fun `een taak van gisteren is nog te laat en wordt net zo afgevinkt`() {
        val overdue = snapshot(listOf(task("oud", "2026-11-01", content = "Al lang open")))
        signIn(withData = overdue)
        now = at("2026-11-13T09:00")
        assertEquals(listOf("oud"), visible())
        assertEquals(WidgetActions.Result.QUEUED, WidgetActions.complete(app, "oud"))
        assertEquals(emptyList<String>(), visible())
    }
}
