package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.core.WidgetStats
import io.github.wnijhof.tickory.store.WidgetStore
import java.time.LocalDate
import java.time.ZoneId
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler

/**
 * Gemeenschappelijk deel van de lijstwidgets. Een widget verversen is alleen opnieuw tekenen uit de gegevens op het
 * toestel; de gegevens zelf haalt de verversing op de achtergrond op (SyncWorker). Ontvangers zijn niet exporteerbaar:
 * alleen Android stuurt ze iets.
 */
abstract class ListWidgetProvider(private val fixed: WidgetSource?) : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        ListWidgets.update(context, manager, appWidgetIds, fixed)
        WidgetClock.scheduleMidnight(context)
    }

    /** De widget is groter of kleiner gemaakt: de opmaak (compact, gewoon, ruim) past zich aan. */
    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle?) {
        ListWidgets.update(context, manager, intArrayOf(appWidgetId), fixed)
    }

    override fun onEnabled(context: Context) {
        // de eerste widget van dit soort: zorgen dat er gegevens komen
        if (Session.isActive(context)) SyncScheduler.refreshNow(context)
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        WidgetConfigStore.remove(context, appWidgetIds)
    }
}

class TodayWidgetProvider : ListWidgetProvider(WidgetSource.Today)

class UpcomingWidgetProvider : ListWidgetProvider(WidgetSource.Upcoming)

/** De widget waarvan je bij het plaatsen kiest wat hij toont (zie [WidgetConfigActivity]). */
class ProjectWidgetProvider : ListWidgetProvider(null)

/** De knop "Taak toevoegen": opent het kleine venster Taak toevoegen, in het laatst gekozen project (eerst de Inbox). */
class AddWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) manager.updateAppWidget(id, render(context, manager, id))
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle?) {
        manager.updateAppWidget(appWidgetId, render(context, manager, appWidgetId))
    }

    companion object {
        /** Smaller dan dit toont de knop alleen het plusteken. */
        const val LABEL_MIN_WIDTH_DP = 110

        fun render(context: Context, manager: AppWidgetManager, appWidgetId: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_add)
            val width = manager.getAppWidgetOptions(appWidgetId)?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
            views.setViewVisibility(R.id.add_label, if (width == 0 || width >= LABEL_MIN_WIDTH_DP) View.VISIBLE else View.GONE)
            views.setOnClickPendingIntent(R.id.add_root, WidgetIntents.addTask(context, null))
            return views
        }
    }
}

/**
 * Snelle acties (2x2): Vandaag, Inbox, Nieuwe notitie en Taak toevoegen, elk een knop. Geen gegevens, geen netwerk: alleen vaste
 * intenties naar de app (zie [WidgetIntents]).
 */
class QuickActionsWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) manager.updateAppWidget(id, render(context, id))
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        WidgetConfigStore.remove(context, appWidgetIds)
    }

    companion object {
        fun render(context: Context, appWidgetId: Int = AppWidgetManager.INVALID_APPWIDGET_ID): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_quick_actions)
            val options = WidgetConfigStore.options(context, appWidgetId)
            val look = WidgetPalette.resolve(context, options)
            views.setInt(R.id.quick_bg, "setImageAlpha", options.alpha)
            views.setInt(R.id.quick_bg, "setColorFilter", look.background)
            for (name in listOf(R.id.quick_today_bg, R.id.quick_inbox_bg, R.id.quick_note_bg, R.id.quick_add_bg)) {
                views.setInt(name, "setImageAlpha", options.alpha)
                views.setInt(name, "setColorFilter", look.toolbar)
            }
            for (name in listOf(R.id.quick_today_icon, R.id.quick_inbox_icon, R.id.quick_note_icon, R.id.quick_add_icon)) views.setInt(name, "setColorFilter", look.accent)
            views.setOnClickPendingIntent(R.id.quick_today, WidgetIntents.openView(context, DeepLink.VIEW_TODAY))
            views.setOnClickPendingIntent(R.id.quick_inbox, WidgetIntents.openView(context, DeepLink.VIEW_INBOX))
            views.setOnClickPendingIntent(R.id.quick_note, WidgetIntents.addNote(context))
            views.setOnClickPendingIntent(R.id.quick_add, WidgetIntents.addTask(context, null))
            return views
        }
    }
}

/**
 * Productiviteit (4x2): hoeveel je vandaag en deze week afvinkte tegenover je doelen, en je reeks dagen. De gegevens komen van de
 * verversing op de achtergrond (SyncWorker, `GET /stats`) en staan op het toestel; tekenen doet geen netwerkverkeer. Een tik opent
 * het scherm Productiviteit in de app.
 */
class ProductivityWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) manager.updateAppWidget(id, render(context, appWidgetId = id))
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle?) {
        manager.updateAppWidget(appWidgetId, render(context, appWidgetId = appWidgetId))
    }

    override fun onDeleted(context: Context, appWidgetIds: IntArray) {
        WidgetConfigStore.remove(context, appWidgetIds)
    }

    override fun onEnabled(context: Context) {
        if (Session.isActive(context)) SyncScheduler.refreshNow(context)
    }

    companion object {
        /** Staat er (minstens) één widget Productiviteit op het scherm? Dan haalt de verversing de statistieken ook op. */
        fun isPlaced(context: Context): Boolean =
            AppWidgetManager.getInstance(context).getAppWidgetIds(android.content.ComponentName(context, ProductivityWidgetProvider::class.java)).isNotEmpty()

        /** De balk: hoeveel procent van het doel (0 als er geen doel is). */
        fun percent(done: Int, goal: Int): Int = if (goal <= 0) 0 else minOf(100, done * 100 / goal)

        /** De reeks tegenover een week: zeven dagen achter elkaar is een volle balk. */
        const val STREAK_FULL_DAYS = 7

        fun render(context: Context, today: LocalDate = LocalDate.now(ZoneId.systemDefault()), appWidgetId: Int = AppWidgetManager.INVALID_APPWIDGET_ID): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_productivity)
            val options = WidgetConfigStore.options(context, appWidgetId)
            val look = WidgetPalette.resolve(context, options)
            views.setInt(R.id.prod_bg, "setImageAlpha", options.alpha)
            views.setInt(R.id.prod_bg, "setColorFilter", look.background)
            for (id in intArrayOf(R.id.prod_daily_count, R.id.prod_weekly_count, R.id.prod_streak_count)) views.setTextColor(id, look.text)
            for (id in intArrayOf(R.id.prod_daily_label, R.id.prod_weekly_label, R.id.prod_streak_label, R.id.prod_message)) views.setTextColor(id, look.textSoft)
            for (id in intArrayOf(R.id.prod_daily_icon, R.id.prod_weekly_icon, R.id.prod_streak_icon)) views.setInt(id, "setColorFilter", look.accent)
            if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.S) { // de balken in de kleur van het thema (kan pas vanaf Android 12)
                for (id in intArrayOf(R.id.prod_daily_bar, R.id.prod_weekly_bar, R.id.prod_streak_bar)) {
                    views.setColorStateList(id, "setProgressTintList", android.content.res.ColorStateList.valueOf(look.accent))
                    views.setColorStateList(id, "setProgressBackgroundTintList", android.content.res.ColorStateList.valueOf(look.divider))
                }
            }
            // "Tikken op de widget" (instelling): het scherm Productiviteit, of de startpagina
            views.setOnClickPendingIntent(
                R.id.prod_root,
                if (WidgetConfigStore.tapAction(context, appWidgetId) == WidgetConfigStore.TAP_HOME) WidgetIntents.openApp(context)
                else WidgetIntents.openView(context, io.github.wnijhof.tickory.core.DeepLink.VIEW_PRODUCTIVITY),
            )
            val stats: WidgetStats? = if (Session.isActive(context)) WidgetStore.stats(context) else null
            val rows = intArrayOf(R.id.prod_row_daily, R.id.prod_row_weekly, R.id.prod_row_streak)
            if (stats == null) {
                // niet aangemeld, verlopen, of de eerste gegevens zijn er nog niet
                views.setTextViewText(R.id.prod_message, context.getString(if (Session.isActive(context)) R.string.widget_loading else R.string.widget_signed_out))
                views.setViewVisibility(R.id.prod_message, View.VISIBLE)
                for (row in rows) views.setViewVisibility(row, View.GONE)
                return views
            }
            views.setViewVisibility(R.id.prod_message, View.GONE)
            for (row in rows) views.setViewVisibility(row, View.VISIBLE)

            val day = stats.doneToday(today)
            val week = stats.doneThisWeek(today)
            val streak = stats.dayStreak(today)
            views.setTextViewText(R.id.prod_daily_count, if (stats.goalDaily > 0) "$day/${stats.goalDaily}" else "$day")
            views.setProgressBar(R.id.prod_daily_bar, 100, percent(day, stats.goalDaily), false)
            views.setContentDescription(R.id.prod_row_daily, if (stats.goalDaily > 0) context.getString(R.string.widget_prod_daily_desc, day, stats.goalDaily) else context.getString(R.string.widget_prod_daily_nogoal, day))
            views.setTextViewText(R.id.prod_weekly_count, if (stats.goalWeekly > 0) "$week/${stats.goalWeekly}" else "$week")
            views.setProgressBar(R.id.prod_weekly_bar, 100, percent(week, stats.goalWeekly), false)
            views.setContentDescription(R.id.prod_row_weekly, if (stats.goalWeekly > 0) context.getString(R.string.widget_prod_weekly_desc, week, stats.goalWeekly) else context.getString(R.string.widget_prod_weekly_nogoal, week))
            views.setTextViewText(R.id.prod_streak_count, streak?.toString() ?: "–")
            views.setProgressBar(R.id.prod_streak_bar, 100, if (streak == null) 0 else percent(streak, STREAK_FULL_DAYS), false)
            views.setContentDescription(R.id.prod_row_streak, if (streak == null) context.getString(R.string.widget_prod_streak_off) else context.getString(R.string.widget_prod_streak_desc, streak))
            return views
        }
    }
}

/** De knop "Notitie toevoegen": opent het kleine venster Notitie toevoegen, op dezelfde manier als de knop Taak toevoegen. */
class AddNoteWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        for (id in appWidgetIds) manager.updateAppWidget(id, render(context, manager, id))
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle?) {
        manager.updateAppWidget(appWidgetId, render(context, manager, appWidgetId))
    }

    companion object {
        fun render(context: Context, manager: AppWidgetManager, appWidgetId: Int): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_add_note)
            val width = manager.getAppWidgetOptions(appWidgetId)?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0
            views.setViewVisibility(R.id.add_note_label, if (width == 0 || width >= AddWidgetProvider.LABEL_MIN_WIDTH_DP) View.VISIBLE else View.GONE)
            views.setOnClickPendingIntent(R.id.add_note_root, WidgetIntents.addNote(context))
            return views
        }
    }
}

/** Het opnieuw tekenen van alle widgets na een systeemgebeurtenis (nieuwe dag, andere tijdzone, taal). */
class WidgetTickReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        WidgetUpdater.updateAll(context)
    }
}
