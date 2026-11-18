package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ContentKind
import io.github.wnijhof.tickory.core.WidgetContent
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.WidgetSize
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.WidgetConfigStore
import java.time.Instant
import java.time.ZoneId

/** Tekent de lijstwidgets (Vandaag, Binnenkort, Project of lijst): de kop en de melding; de regels komen uit [WidgetListService]. */
object ListWidgets {
    /** Wat bij deze widget hoort: de vaste bron van Vandaag en Binnenkort, of de gekozen bron van Project of lijst. */
    fun sourceOf(context: Context, appWidgetId: Int, fixed: WidgetSource?): WidgetSource {
        if (fixed != null) return fixed
        return WidgetSource.parse(WidgetConfigStore.get(context, appWidgetId)) ?: WidgetSource.Today
    }

    /** De bron zoals de lijst (de factory) hem leest: de bewaarde keuze, anders Vandaag. */
    fun storedSource(context: Context, appWidgetId: Int): WidgetSource = WidgetSource.parse(WidgetConfigStore.get(context, appWidgetId)) ?: WidgetSource.Today

    // De oudere vorm met een RemoteViewsService blijft nodig: de nieuwere (RemoteCollectionItems) bestaat pas vanaf Android 12 en bewaart alles in het geheugen van de launcher.
    @Suppress("DEPRECATION")
    fun update(context: Context, manager: AppWidgetManager, ids: IntArray, fixed: WidgetSource?) {
        for (id in ids) {
            if (fixed != null) WidgetConfigStore.set(context, id, fixed.key) // de lijst leest de bron uit de bewaarde keuze
            manager.updateAppWidget(id, render(context, manager, id, sourceOf(context, id, fixed)))
        }
        manager.notifyAppWidgetViewDataChanged(ids, R.id.list)
    }

    fun sizeOf(manager: AppWidgetManager, appWidgetId: Int): WidgetSize {
        val options = manager.getAppWidgetOptions(appWidgetId)
        return WidgetSize.of(
            options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_WIDTH, 0) ?: 0,
            options?.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0) ?: 0,
        )
    }

    @Suppress("DEPRECATION") // zie update()
    /**
     * Waarom een filter hier niets toont. Een naam die niet (meer) bestaat zegt de app ook; al het andere kan de app wel lezen
     * (anders was het filter niet bewaard), dus dan gaat het om een datum in gewone taal, die alleen de app kent.
     */
    fun filterProblem(context: Context, c: WidgetContent): String {
        val part = c.problem ?: ""
        return when (c.filterError?.code) {
            "unknown_project", "unknown_section", "unknown_label", "unknown_user" -> context.getString(R.string.widget_filter_unknown_name, part)
            else -> context.getString(R.string.widget_filter_unreadable, part)
        }
    }

    fun render(context: Context, manager: AppWidgetManager, appWidgetId: Int, source: WidgetSource): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_list)
        val size = sizeOf(manager, appWidgetId)
        applyLook(context, views, WidgetConfigStore.options(context, appWidgetId))
        val state = WidgetModel.state(context, source)

        // het formaat: kleiner betekent compacter (geen ondertitel, het aantal naast de titel), groter wat ruimer
        views.setTextViewTextSize(R.id.title, TypedValue.COMPLEX_UNIT_SP, when (size) { WidgetSize.SMALL -> 15f; WidgetSize.MEDIUM -> 18f; WidgetSize.LARGE -> 20f })

        val content = (state as? WidgetModel.State.Ready)?.content
        val snapshot = (state as? WidgetModel.State.Ready)?.snapshot
        val title = WidgetModel.title(context, source, content)
        var subtitle: String? = null
        var message: String? = null
        var description = title
        when (state) {
            WidgetModel.State.SignedOut -> message = context.getString(R.string.widget_signed_out)
            WidgetModel.State.Expired -> message = context.getString(R.string.widget_expired)
            WidgetModel.State.Loading -> message = context.getString(R.string.widget_loading)
            is WidgetModel.State.Ready -> {
                val c = state.content
                val count = context.resources.getQuantityString(R.plurals.widget_task_count, c.count, c.count)
                description = "$title, $count"
                subtitle = if (c.kind == ContentKind.TODAY) "${todayLabel(context)} · $count" else count
                message = when {
                    c.kind == ContentKind.FILTER && c.missing -> context.getString(R.string.widget_filter_missing)
                    c.filterError != null -> filterProblem(context, c)
                    c.missing -> context.getString(R.string.widget_project_missing)
                    c.count == 0 -> context.getString(
                        when (c.kind) {
                            ContentKind.TODAY -> R.string.widget_empty_today
                            ContentKind.UPCOMING -> R.string.widget_empty_upcoming
                            ContentKind.FILTER -> R.string.widget_empty_filter
                            else -> R.string.widget_empty_project
                        },
                    )
                    else -> null
                }
                if (c.missing || c.filterError != null) subtitle = null
            }
        }

        if (size == WidgetSize.SMALL && subtitle != null) {
            views.setTextViewText(R.id.title, "$title · ${(state as WidgetModel.State.Ready).content.count}")
            views.setViewVisibility(R.id.subtitle, View.GONE)
        } else {
            views.setTextViewText(R.id.title, title)
            views.setViewVisibility(R.id.subtitle, if (subtitle != null) View.VISIBLE else View.GONE)
            if (subtitle != null) views.setTextViewText(R.id.subtitle, subtitle)
        }
        views.setContentDescription(R.id.header_text, description)

        views.setViewVisibility(R.id.list, if (message == null) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.message, if (message != null) View.VISIBLE else View.GONE)
        if (message != null) views.setTextViewText(R.id.message, message)

        // "+" naast de kop opent Taak toevoegen, in het project van deze lijst; zonder aanmelding opent het gewoon de app
        views.setOnClickPendingIntent(R.id.add, WidgetIntents.addTask(context, WidgetModel.addTarget(source, snapshot)))
        views.setOnClickPendingIntent(R.id.header_text, WidgetIntents.openApp(context))
        views.setOnClickPendingIntent(R.id.message, WidgetIntents.openApp(context))

        val adapter = Intent(context, WidgetListService::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            // een eigen adres per widget: Android bewaart de lijst per intentie, en vergelijkt daarbij de extra's niet
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("list").appendPath(appWidgetId.toString()).build())
        views.setRemoteAdapter(R.id.list, adapter)
        views.setPendingIntentTemplate(R.id.list, WidgetIntents.itemTemplate(context, appWidgetId))
        return views
    }

    /**
     * Het uiterlijk dat per widget is gekozen: de doorzichtigheid van de achtergrond en, bij een vast licht of donker thema, de kleuren van
     * de achtergrond, de kop en de melding. De regels (de lijst) lezen hetzelfde uit WidgetListService.
     */
    internal fun applyLook(context: Context, views: RemoteViews, options: WidgetOptions) {
        views.setInt(R.id.widget_bg, "setImageAlpha", options.alpha)
        val palette = WidgetPalette.of(context, options.theme) ?: return
        views.setInt(R.id.widget_bg, "setColorFilter", palette.background)
        views.setTextColor(R.id.title, palette.text)
        views.setTextColor(R.id.subtitle, palette.textSoft)
        views.setTextColor(R.id.message, palette.textSoft)
        views.setInt(R.id.add, "setColorFilter", palette.accent)
    }

    private fun todayLabel(context: Context): String {
        val today = Instant.ofEpochMilli(AppClock.now()).atZone(ZoneId.systemDefault()).toLocalDate()
        return DueText.dayMonth(today, today, WidgetModel.lang(context))
    }
}
