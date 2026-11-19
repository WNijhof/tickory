package io.github.wnijhof.tickory.reminders

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DailyOverview
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.WidgetQueue
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.widget.WidgetIntents
import java.time.ZoneId

/**
 * Het ochtendoverzicht en de avondreview: één onnauwkeurig alarm per soort per dag (zoals het middernachtalarm van de widgets, zonder
 * speciale toestemming), dat een melding toont met het aantal taken van vandaag. De tijden staan in je instellingen en komen mee met de
 * gewone verversing (WidgetSnapshot); [schedule] zet de alarmen opnieuw na elke verversing, na het opstarten en na een tijdwissel.
 * De melding bevat alleen aantallen, geen taaknamen (een melding is ook zonder ontgrendelen te lezen).
 */
object DailyOverviewNotifier {
    private const val TAG = "TickoryOverview"
    const val CHANNEL_ID = "overview"
    const val ACTION = "io.github.wnijhof.tickory.action.OVERVIEW"
    private const val NOTIFICATION_BASE = 2000

    private fun pending(context: Context, kind: DailyOverview.Kind, flag: Int): PendingIntent? {
        val intent = Intent(context, OverviewReceiver::class.java).setAction(ACTION)
            .setData(Uri.Builder().scheme("tickory").authority("overview").appendPath(kind.name.lowercase()).build())
        return PendingIntent.getBroadcast(context, kind.ordinal, intent, flag or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun timeOf(context: Context, kind: DailyOverview.Kind): String? {
        if (!Session.isActive(context)) return null
        val snapshot = WidgetStore.visibleSnapshot(context) ?: return null
        return if (kind == DailyOverview.Kind.MORNING) snapshot.morningOverview else snapshot.eveningReview
    }

    /** Zet het alarm van elke soort op het eerstvolgende moment, of haal het weg als die soort uit staat (of er niet is aangemeld). */
    fun schedule(context: Context, nowMs: Long = AppClock.now(), zone: ZoneId = ZoneId.systemDefault()) {
        val app = context.applicationContext
        val manager = app.getSystemService(AlarmManager::class.java) ?: return
        for (kind in DailyOverview.Kind.entries) {
            val time = timeOf(app, kind)
            if (time == null) {
                pending(app, kind, PendingIntent.FLAG_NO_CREATE)?.let { manager.cancel(it); it.cancel() }
                continue
            }
            val intent = pending(app, kind, PendingIntent.FLAG_UPDATE_CURRENT) ?: continue
            try {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, DailyOverview.nextTriggerMs(nowMs, zone, time), intent)
            } catch (e: RuntimeException) {
                Log.w(TAG, "alarm zetten mislukt: ${e.javaClass.simpleName}")
            }
        }
    }

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.channel_overview), NotificationManager.IMPORTANCE_DEFAULT)
        channel.description = context.getString(R.string.channel_overview_description)
        manager.createNotificationChannel(channel)
    }

    /** Wat de melding zegt, of null als er niets te melden is (de avondreview zwijgt als alles af is). */
    fun text(context: Context, kind: DailyOverview.Kind, summary: DailyOverview.Summary): Pair<String, String>? {
        val r = context.resources
        return when (kind) {
            DailyOverview.Kind.MORNING -> {
                val title = context.getString(R.string.overview_morning_title)
                if (summary.total == 0) return title to context.getString(R.string.overview_morning_empty)
                val count = r.getQuantityString(R.plurals.overview_today_count, summary.total, summary.total)
                title to if (summary.overdue > 0) context.getString(R.string.overview_with_overdue, count, summary.overdue) else count
            }
            DailyOverview.Kind.EVENING -> {
                if (summary.total == 0) return null
                context.getString(R.string.overview_evening_title) to r.getQuantityString(R.plurals.overview_left_count, summary.total, summary.total)
            }
        }
    }

    /** Toon de melding van deze soort (als er iets te melden is en meldingen aan staan). */
    fun show(context: Context, kind: DailyOverview.Kind, nowMs: Long = AppClock.now(), zone: ZoneId = ZoneId.systemDefault()) {
        val app = context.applicationContext
        if (!Session.isActive(app) || timeOf(app, kind) == null) return
        if (!NotificationManagerCompat.from(app).areNotificationsEnabled()) return
        val snapshot = WidgetStore.visibleSnapshot(app) ?: return
        val hidden = WidgetQueue.forAccount(WidgetStore.queue(app), snapshot.accountId).mapTo(HashSet()) { it.taskId }
        val (title, body) = text(app, kind, DailyOverview.summary(snapshot, hidden, nowMs, zone)) ?: return
        ensureChannel(app)
        val notification = NotificationCompat.Builder(app, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setContentTitle(title)
            .setContentText(body)
            .setAutoCancel(true)
            .setContentIntent(WidgetIntents.openView(app, DeepLink.VIEW_TODAY))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .build()
        try {
            NotificationManagerCompat.from(app).notify(NOTIFICATION_BASE + kind.ordinal, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "melding tonen niet toegestaan") // de toestemming is net ingetrokken
        }
    }
}

/** Het alarm van het ochtendoverzicht of de avondreview: de melding tonen en het alarm voor morgen zetten. */
class OverviewReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val kind = intent.data?.lastPathSegment?.let { name -> DailyOverview.Kind.entries.firstOrNull { it.name.equals(name, ignoreCase = true) } } ?: return
        try {
            DailyOverviewNotifier.show(context, kind)
        } finally {
            DailyOverviewNotifier.schedule(context)
        }
    }
}
