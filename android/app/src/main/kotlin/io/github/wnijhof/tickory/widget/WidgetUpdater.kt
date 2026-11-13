package io.github.wnijhof.tickory.widget

import android.app.AlarmManager
import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.util.Log
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.reminders.AppClock
import java.time.Instant
import java.time.ZoneId

/**
 * Tekent alle widgets opnieuw uit de gegevens op het toestel. Aangeroepen na elke verversing, na een tik in een widget,
 * bij aanmelden en afmelden, en bij een nieuwe dag, tijdzone of taal.
 */
object WidgetUpdater {
    private const val TAG = "TickoryWidgets"

    private val LIST_PROVIDERS = mapOf<Class<*>, WidgetSource?>(
        TodayWidgetProvider::class.java to WidgetSource.Today,
        UpcomingWidgetProvider::class.java to WidgetSource.Upcoming,
        ProjectWidgetProvider::class.java to null,
    )

    fun updateAll(context: Context) {
        val app = context.applicationContext
        try {
            val manager = AppWidgetManager.getInstance(app)
            var any = false
            for ((provider, fixed) in LIST_PROVIDERS) {
                val ids = manager.getAppWidgetIds(ComponentName(app, provider))
                if (ids.isEmpty()) continue
                any = true
                ListWidgets.update(app, manager, ids, fixed)
            }
            val addIds = manager.getAppWidgetIds(ComponentName(app, AddWidgetProvider::class.java))
            for (id in addIds) manager.updateAppWidget(id, AddWidgetProvider.render(app, manager, id))
            if (addIds.isNotEmpty()) any = true
            if (any) WidgetClock.scheduleMidnight(app) else WidgetClock.cancel(app)
        } catch (e: RuntimeException) {
            // een widget die niet getekend kan worden (launcher weg, gegevens onleesbaar) mag niets anders breken
            Log.w(TAG, "widgets verversen mislukt: ${e.javaClass.simpleName}")
        }
    }
}

/**
 * "Vandaag" en "te laat" hangen aan de datum: na middernacht moet een widget zich opnieuw tekenen, ook als er geen
 * verbinding is. Eén onnauwkeurig alarm (zonder speciale toestemming, het toestel mag het uitstellen) per dag.
 */
object WidgetClock {
    private fun pending(context: Context): PendingIntent =
        PendingIntent.getBroadcast(context, 0, Intent(context, WidgetTickReceiver::class.java), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)

    /** Het eerstvolgende middernacht (plus een halve minuut) in de tijdzone van het toestel. */
    fun nextMidnightMs(nowMs: Long, zone: ZoneId = ZoneId.systemDefault()): Long =
        Instant.ofEpochMilli(nowMs).atZone(zone).toLocalDate().plusDays(1).atStartOfDay(zone).toInstant().toEpochMilli() + 30_000L

    fun scheduleMidnight(context: Context) {
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        manager.set(AlarmManager.RTC, nextMidnightMs(AppClock.now()), pending(context))
    }

    fun cancel(context: Context) {
        context.getSystemService(AlarmManager::class.java)?.cancel(pending(context))
    }
}
