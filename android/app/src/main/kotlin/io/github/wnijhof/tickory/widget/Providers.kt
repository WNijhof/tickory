package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.store.WidgetConfigStore
import io.github.wnijhof.tickory.store.WidgetStore
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

/** De knop "Taak toevoegen": opent de app op het venster Taak toevoegen, in de Inbox. */
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
            views.setOnClickPendingIntent(R.id.add_root, WidgetIntents.addTask(context, WidgetStore.visibleSnapshot(context)?.inboxId))
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
