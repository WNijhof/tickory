package io.github.wnijhof.tickory.reminders

import android.Manifest
import android.app.AlarmManager
import android.app.Application
import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import androidx.test.core.app.ApplicationProvider
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.core.ReminderInfo
import io.github.wnijhof.tickory.core.SyncSnapshot
import io.github.wnijhof.tickory.core.TaskInfo
import io.github.wnijhof.tickory.store.ReminderStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowAlarmManager
import java.time.Instant
import java.util.TimeZone

/**
 * De hele keten op een nagebootst Android (Robolectric): gegevens van de server, alarmen bij AlarmManager, het alarm
 * dat afgaat, de melding met zijn knoppen, uitstellen, en opnieuw plannen na een herstart. Geen telefoon nodig.
 * Wat hier niet onder valt: of een echt toestel het alarm op tijd bezorgt en de melding echt laat zien en horen.
 */
@Suppress("DEPRECATION") // Robolectric biedt de velden van een gepland alarm nog alleen op deze manier aan
@RunWith(RobolectricTestRunner::class)
@Config(qualifiers = "nl")
class ReminderPipelineTest {
    private val app: Application = ApplicationProvider.getApplicationContext()
    private val alarms get() = shadowOf(app.getSystemService(AlarmManager::class.java))
    private val notifications get() = shadowOf(app.getSystemService(NotificationManager::class.java))
    private val originalZone: TimeZone = TimeZone.getDefault()
    private val minute = 60_000L

    private fun utc(iso: String): Long = Instant.parse(iso).toEpochMilli()

    /** Ver in de toekomst, zodat de echte klok van de pc er niet toe doet. Vrijdag 14 juni 2030, 10:00 in Amsterdam (zomertijd). */
    private val now = utc("2030-06-14T08:00:00Z")

    /** Taak om 14:00 met een herinnering een half uur ervoor: 13:30 in Amsterdam is 11:30 UTC. */
    private val trigger = utc("2030-06-14T11:30:00Z")

    private fun snapshot(due: String? = "2030-06-14T14:00", checked: Boolean = false) = SyncSnapshot(
        tasks = listOf(TaskInfo("task-0001", "Tandarts bellen", due, checked)),
        reminders = listOf(ReminderInfo("rem-00001", "task-0001", "relative", 30, null)),
    )

    private fun fireAlarms() {
        // Wat Android doet als een alarm afgaat: de bewaarde opdracht afleveren bij de ontvanger.
        for (alarm in alarms.scheduledAlarms.toList()) {
            if (alarm.triggerAtMs <= AppClock.now()) AlarmReceiver().onReceive(app, shadowOf(alarm.operation).savedIntent)
        }
    }

    @Before
    fun setUp() {
        TimeZone.setDefault(TimeZone.getTimeZone("Europe/Amsterdam"))
        AppClock.now = { now }
        shadowOf(app).grantPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ShadowAlarmManager.setCanScheduleExactAlarms(true)
    }

    @After
    fun tearDown() {
        AppClock.now = { System.currentTimeMillis() }
        TimeZone.setDefault(originalZone)
    }

    @Test
    fun `na een verversing staat er een exact alarm op het tijdstip van de herinnering`() {
        ReminderEngine.onSynced(app, snapshot())

        val alarm = alarms.scheduledAlarms.single()
        assertEquals(AlarmManager.RTC_WAKEUP, alarm.type)
        assertEquals(trigger, alarm.triggerAtMs)
        assertTrue("moet ook in de slaapstand afgaan", alarm.isAllowWhileIdle)

        val operation = shadowOf(alarm.operation)
        assertTrue(operation.isBroadcast)
        assertTrue("moet onveranderlijk zijn", operation.flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertEquals(AlarmReceiver::class.java.name, operation.savedIntent.component?.className)
        assertEquals("tickory://alarm/reminder/rem-00001", operation.savedIntent.dataString)
        assertNull("het alarm draagt geen gegevens van de taak", operation.savedIntent.extras)

        assertEquals("er is nog niets te melden", 0, notifications.size())
    }

    @Test
    fun `als het alarm afgaat komt de melding, precies een keer`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger }
        fireAlarms()

        val notification = notifications.getNotification("rem-00001", 1)
        assertNotNull("de melding hoort er te staan", notification)
        assertEquals("Tandarts bellen", notification.extras.getString(Notification.EXTRA_TITLE))
        assertEquals("Herinnering · vandaag 14:00", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(Notifications.CHANNEL_ID, notification.channelId)
        assertEquals(Notification.CATEGORY_REMINDER, notification.category)
        assertEquals(trigger, notification.`when`)
        assertEquals(listOf("Voltooien", "Over 10 minuten"), notification.actions.map { it.title.toString() })
        assertEquals("task-0001", notification.extras.getString(Notifications.EXTRA_TASK_ID))
        assertTrue("het verbruikte alarm staat er niet meer", alarms.scheduledAlarms.isEmpty())

        // De melding wegvegen en daarna alles nog eens langslopen (verversing, app naar voren): hij komt niet terug.
        app.getSystemService(NotificationManager::class.java).cancelAll()
        AppClock.now = { trigger + 5 * minute }
        ReminderEngine.replan(app)
        ReminderEngine.onSynced(app, snapshot())
        assertEquals(0, notifications.size())
        assertTrue(alarms.scheduledAlarms.isEmpty())
    }

    @Test
    fun `tikken op de melding opent de app bij de taak`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger }
        fireAlarms()

        val content = shadowOf(notifications.getNotification("rem-00001", 1).contentIntent)
        assertTrue(content.isActivity)
        assertTrue(content.flags and PendingIntent.FLAG_IMMUTABLE != 0)
        assertEquals(MainActivity::class.java.name, content.savedIntent.component?.className)
        assertEquals("task-0001", content.savedIntent.getStringExtra(Notifications.EXTRA_TASK_ID))
    }

    @Test
    fun `over tien minuten - de melding verdwijnt en komt tien minuten later terug`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger }
        fireAlarms()

        val snooze = shadowOf(notifications.getNotification("rem-00001", 1).actions[1].actionIntent)
        assertTrue(snooze.isBroadcast)
        assertEquals(ActionReceiver::class.java.name, snooze.savedIntent.component?.className)
        AppClock.now = { trigger + 2 * minute }
        ActionReceiver().onReceive(app, snooze.savedIntent)

        assertNull("de melding is weg", notifications.getNotification("rem-00001", 1))
        val alarm = alarms.scheduledAlarms.single()
        assertEquals(trigger + 12 * minute, alarm.triggerAtMs)
        assertEquals("tickory://alarm/snooze/rem-00001", shadowOf(alarm.operation).savedIntent.dataString)

        // te vroeg: nog niets
        AppClock.now = { trigger + 11 * minute }
        ReminderEngine.replan(app)
        assertNull(notifications.getNotification("rem-00001", 1))

        // op tijd: dezelfde melding, met beide knoppen
        AppClock.now = { trigger + 12 * minute }
        fireAlarms()
        val again = notifications.getNotification("rem-00001", 1)
        assertNotNull(again)
        assertEquals("Tandarts bellen", again.extras.getString(Notification.EXTRA_TITLE))
        assertEquals(2, again.actions.size)
        assertTrue(alarms.scheduledAlarms.isEmpty())
    }

    @Test
    fun `na een herstart van het toestel staan de alarmen er weer, zonder internet`() {
        ReminderEngine.onSynced(app, snapshot())
        assertEquals(1, alarms.scheduledAlarms.size)

        // Android wist bij uitschakelen alle alarmen
        for (alarm in alarms.scheduledAlarms.toList()) app.getSystemService(AlarmManager::class.java).cancel(alarm.operation!!)
        assertTrue(alarms.scheduledAlarms.isEmpty())

        SystemEventsReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertEquals(trigger, alarms.scheduledAlarms.single().triggerAtMs)
    }

    @Test
    fun `stond het toestel uit toen de herinnering moest afgaan, dan komt hij bij het opstarten alsnog - tot een uur later`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger + 40 * minute }
        SystemEventsReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertNotNull(notifications.getNotification("rem-00001", 1))
    }

    @Test
    fun `meer dan een uur te laat komt de herinnering niet meer`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger + 61 * minute }
        SystemEventsReceiver().onReceive(app, Intent(Intent.ACTION_BOOT_COMPLETED))
        assertEquals(0, notifications.size())
        assertTrue(alarms.scheduledAlarms.isEmpty())
    }

    @Test
    fun `in een andere tijdzone verschuift het alarm mee met de klok`() {
        ReminderEngine.onSynced(app, snapshot())
        TimeZone.setDefault(TimeZone.getTimeZone("America/New_York"))
        SystemEventsReceiver().onReceive(app, Intent(Intent.ACTION_TIMEZONE_CHANGED))
        // 13:30 op de klok in New York (zomertijd, UTC-4) is 17:30 UTC
        assertEquals(utc("2030-06-14T17:30:00Z"), alarms.scheduledAlarms.single().triggerAtMs)
    }

    @Test
    fun `de taak is elders afgevinkt - alarm en melding verdwijnen bij de volgende verversing`() {
        ReminderEngine.onSynced(app, snapshot())
        assertEquals(1, alarms.scheduledAlarms.size)
        ReminderEngine.onSynced(app, snapshot(checked = true))
        assertTrue(alarms.scheduledAlarms.isEmpty())

        // en een melding die al in beeld stond
        ReminderEngine.onSynced(app, snapshot(due = "2030-06-14T15:00"))
        AppClock.now = { trigger + 60 * minute }
        fireAlarms()
        assertNotNull(notifications.getNotification("rem-00001", 1))
        ReminderEngine.onSynced(app, snapshot(due = "2030-06-14T15:00", checked = true))
        assertNull(notifications.getNotification("rem-00001", 1))
    }

    @Test
    fun `afmelden wist alle alarmen, meldingen en bewaarde gegevens`() {
        ReminderEngine.onSynced(app, snapshot())
        ReminderEngine.onSynced(app, SyncSnapshot(
            tasks = listOf(TaskInfo("task-0001", "Tandarts bellen", "2030-06-14T14:00"), TaskInfo("task-0002", "Nu", "2030-06-14T10:00")),
            reminders = listOf(ReminderInfo("rem-00001", "task-0001", "relative", 30, null), ReminderInfo("rem-00002", "task-0002", "relative", 0, null)),
        ))
        assertEquals(1, alarms.scheduledAlarms.size)
        assertNotNull("rem-00002 was meteen aan de beurt", notifications.getNotification("rem-00002", 1))

        ReminderEngine.clear(app, keepShown = false)
        assertTrue(alarms.scheduledAlarms.isEmpty())
        assertEquals(0, notifications.size())
        val state = ReminderStore.load(app)
        assertTrue(state.snapshot.tasks.isEmpty())
        assertTrue(state.scheduled.isEmpty())
        assertTrue(state.shown.isEmpty())
    }

    @Test
    fun `tweehonderdvijftig herinneringen - er komen er tweehonderd als alarm`() {
        val tasks = (1..250).map { TaskInfo("task-%04d".format(it), "Taak $it", null) }
        val reminders = (1..250).map {
            val at = Instant.ofEpochMilli(now + it * 3 * minute).atZone(java.time.ZoneId.of("Europe/Amsterdam")).toLocalDateTime().toString().substring(0, 16)
            ReminderInfo("rem-%05d".format(it), "task-%04d".format(it), "absolute", null, at)
        }
        ReminderEngine.onSynced(app, SyncSnapshot(tasks, reminders))
        assertEquals(200, alarms.scheduledAlarms.size)
        assertEquals(now + 3 * minute, alarms.scheduledAlarms.minOf { it.triggerAtMs })
        assertEquals(now + 200 * 3 * minute, alarms.scheduledAlarms.maxOf { it.triggerAtMs })
    }

    @Test
    fun `zonder toestemming voor exacte alarmen komt er toch een alarm, bij benadering`() {
        ShadowAlarmManager.setCanScheduleExactAlarms(false)
        ReminderEngine.onSynced(app, snapshot())
        val alarm = alarms.scheduledAlarms.single()
        assertEquals(trigger, alarm.triggerAtMs)
        assertTrue(alarm.isAllowWhileIdle)
    }

    @Test
    fun `zonder toestemming voor meldingen loopt er niets vast`() {
        shadowOf(app).denyPermissions(Manifest.permission.POST_NOTIFICATIONS)
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger }
        fireAlarms()
        assertEquals(0, notifications.size())
    }

    @Test
    fun `het kanaal Herinneringen bestaat, met hoge prioriteit`() {
        Notifications.ensureChannel(app)
        val channel = app.getSystemService(NotificationManager::class.java).getNotificationChannel(Notifications.CHANNEL_ID)
        assertEquals("Herinneringen", channel.name.toString())
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channel.importance)
    }

    @Test
    @Config(qualifiers = "en")
    fun `op een Engels toestel zijn melding en kanaal Engels`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger }
        fireAlarms()
        val notification = notifications.getNotification("rem-00001", 1)
        // Engels volgt de klokinstelling van het toestel; het nagebootste toestel staat op de twaalfuursklok
        assertEquals("Reminder · today 2:00 PM", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(listOf("Complete", "In 10 minutes"), notification.actions.map { it.title.toString() })
        val channel = app.getSystemService(NotificationManager::class.java).getNotificationChannel(Notifications.CHANNEL_ID)
        assertEquals("Reminders", channel.name.toString())
    }

    @Test
    @Config(qualifiers = "de")
    fun `op een toestel in een andere taal is de app Nederlands`() {
        ReminderEngine.onSynced(app, snapshot())
        AppClock.now = { trigger }
        fireAlarms()
        val notification = notifications.getNotification("rem-00001", 1)
        assertEquals("Herinnering · vandaag 14:00", notification.extras.getCharSequence(Notification.EXTRA_TEXT).toString())
        assertEquals(listOf("Voltooien", "Over 10 minuten"), notification.actions.map { it.title.toString() })
    }

    @Test
    fun `het manifest meldt de ontvangers aan voor opstarten, tijdzone en klok`() {
        for (action in listOf(Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_TIMEZONE_CHANGED, Intent.ACTION_TIME_CHANGED, Intent.ACTION_MY_PACKAGE_REPLACED)) {
            val found = app.packageManager.queryBroadcastReceivers(Intent(action).setPackage(app.packageName), 0)
            assertTrue(action, found.any { it.activityInfo.name == SystemEventsReceiver::class.java.name })
        }
    }
}
