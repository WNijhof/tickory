package io.github.wnijhof.tickory.widget

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import io.github.wnijhof.tickory.core.DailyOverview
import io.github.wnijhof.tickory.core.WidgetFixtures.at
import io.github.wnijhof.tickory.core.WidgetFixtures.snapshot
import io.github.wnijhof.tickory.core.WidgetFixtures.task
import io.github.wnijhof.tickory.reminders.DailyOverviewNotifier
import io.github.wnijhof.tickory.reminders.OverviewReceiver
import io.github.wnijhof.tickory.sync.Session
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test
import org.robolectric.Shadows.shadowOf
import android.content.Intent
import android.net.Uri

/** De alarmen en meldingen van het ochtendoverzicht en de avondreview. */
class DailyOverviewUiTest : WidgetTestBase() {
    private val alarms get() = shadowOf(app.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
    private val notifications get() = shadowOf(app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)

    private val data = snapshot(listOf(task("oud", "2026-11-12"), task("nu", "2026-11-13"), task("nog", "2026-11-13")))

    @Test
    fun `de alarmen staan op de gekozen tijden, en weg als het uit staat of zonder aanmelding`() {
        signIn(withData = data.copy(morningOverview = "08:00", eveningReview = "18:30"))
        DailyOverviewNotifier.schedule(app, nowMs = at("2026-11-13T09:00"))
        val times = alarms.scheduledAlarms.map { it.triggerAtMs }.sorted()
        assertEquals(listOf(at("2026-11-13T18:30"), at("2026-11-14T08:00")), times)

        // alleen de avondreview aan
        signIn(withData = data.copy(morningOverview = null, eveningReview = "18:30"))
        DailyOverviewNotifier.schedule(app, nowMs = at("2026-11-13T09:00"))
        assertEquals(listOf(at("2026-11-13T18:30")), alarms.scheduledAlarms.map { it.triggerAtMs })

        // afgemeld: geen alarm meer
        Session.signOut(app)
        DailyOverviewNotifier.schedule(app, nowMs = at("2026-11-13T09:00"))
        assertEquals(0, alarms.scheduledAlarms.size)
    }

    @Test
    fun `de melding van de ochtend noemt aantallen, niet de namen van taken`() {
        signIn(withData = data.copy(morningOverview = "08:00"))
        DailyOverviewNotifier.show(app, DailyOverview.Kind.MORNING, nowMs = at("2026-11-13T08:00"))
        val n = notifications.getNotification(2000 + DailyOverview.Kind.MORNING.ordinal)
        assertNotNull(n)
        assertEquals("Plan je dag", shadowOf(n).contentTitle.toString())
        assertEquals("3 taken vandaag, 1 over tijd", shadowOf(n).contentText.toString())
        assertNull(notifications.getNotification(2000 + DailyOverview.Kind.EVENING.ordinal))
    }

    @Test
    fun `de avondreview zwijgt als alles af is, en zegt anders wat er nog over is`() {
        signIn(withData = snapshot(emptyList()).copy(eveningReview = "18:00"))
        DailyOverviewNotifier.show(app, DailyOverview.Kind.EVENING, nowMs = at("2026-11-13T18:00"))
        assertNull(notifications.getNotification(2000 + DailyOverview.Kind.EVENING.ordinal))
        signIn(withData = data.copy(eveningReview = "18:00"))
        DailyOverviewNotifier.show(app, DailyOverview.Kind.EVENING, nowMs = at("2026-11-13T18:00"))
        assertEquals("Nog 3 taken voor vandaag", shadowOf(notifications.getNotification(2000 + DailyOverview.Kind.EVENING.ordinal)).contentText.toString())
    }

    @Test
    fun `een soort die uit staat toont niets, ook als het alarm van gisteren nog afgaat`() {
        signIn(withData = data.copy(morningOverview = null))
        val intent = Intent(app, OverviewReceiver::class.java).setAction(DailyOverviewNotifier.ACTION).setData(Uri.parse("tickory://overview/morning"))
        OverviewReceiver().onReceive(app, intent)
        assertNull(notifications.getNotification(2000 + DailyOverview.Kind.MORNING.ordinal))
        assertEquals(0, alarms.scheduledAlarms.size)
    }
}
