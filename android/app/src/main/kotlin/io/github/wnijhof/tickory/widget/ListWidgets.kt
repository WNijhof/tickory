package io.github.wnijhof.tickory.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ContentKind
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.reminders.AppClock
import java.time.Instant
import java.time.ZoneId
import io.github.wnijhof.tickory.core.WidgetColors
import io.github.wnijhof.tickory.core.WidgetContent
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.WidgetSize
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.store.WidgetConfigStore

/**
 * Tekent de lijstwidgets (Vandaag, Binnenkort, Takenlijst) zoals de takenlijst van de Todoist-app: de balk bovenaan (beeldmerk, titel met een
 * pijltje om een ander overzicht te kiezen, de ronde "+"), de melding of lege staat; de regels komen uit [WidgetListService].
 */
object ListWidgets {
    /**
     * Wat bij deze widget hoort: de bewaarde keuze (elke lijstwidget kiest zijn overzicht zelf, via het pijltje in de balk), anders waarmee
     * dit soort widget begint (Vandaag, Binnenkort), anders Vandaag.
     */
    fun sourceOf(context: Context, appWidgetId: Int, initial: WidgetSource?): WidgetSource =
        WidgetSource.parse(WidgetConfigStore.get(context, appWidgetId)) ?: initial ?: WidgetSource.Today

    /** De bron zoals de lijst (de factory) hem leest: de bewaarde keuze, anders Vandaag. */
    fun storedSource(context: Context, appWidgetId: Int): WidgetSource = WidgetSource.parse(WidgetConfigStore.get(context, appWidgetId)) ?: WidgetSource.Today

    // De oudere vorm met een RemoteViewsService blijft nodig: de nieuwere (RemoteCollectionItems) bestaat pas vanaf Android 12 en bewaart alles in het geheugen van de launcher.
    @Suppress("DEPRECATION")
    fun update(context: Context, manager: AppWidgetManager, ids: IntArray, initial: WidgetSource?) {
        for (id in ids) {
            if (initial != null && WidgetConfigStore.get(context, id) == null) WidgetConfigStore.set(context, id, initial.key) // de lijst leest de bron uit de bewaarde keuze
            manager.updateAppWidget(id, render(context, manager, id, sourceOf(context, id, initial)))
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
        val options = WidgetConfigStore.options(context, appWidgetId)
        val look = WidgetPalette.resolve(context, options)
        applyLook(views, options, look)
        val state = WidgetModel.state(context, source)

        // het formaat: kleiner betekent een iets kleinere titel; de lettergrootte van de instellingen telt erover
        val titleSize = when (size) { WidgetSize.SMALL -> 15f; WidgetSize.MEDIUM -> 16f; WidgetSize.LARGE -> 18f } * options.font.scale
        views.setTextViewTextSize(R.id.title, TypedValue.COMPLEX_UNIT_SP, titleSize)

        val content = (state as? WidgetModel.State.Ready)?.content
        val snapshot = (state as? WidgetModel.State.Ready)?.snapshot
        val title = WidgetModel.title(context, source, content)
        var message: String? = null
        var empty = false
        var description = title
        var subtitle: String? = null
        when (state) {
            WidgetModel.State.SignedOut -> message = context.getString(R.string.widget_signed_out)
            WidgetModel.State.Expired -> message = context.getString(R.string.widget_expired)
            WidgetModel.State.Loading -> message = context.getString(R.string.widget_loading)
            is WidgetModel.State.Ready -> {
                val c = state.content
                val count = context.resources.getQuantityString(R.plurals.widget_task_count, c.count, c.count)
                description = "$title, $count"
                subtitle = if (c.kind == ContentKind.TODAY) "${todayLabel(context)} · $count" else count
                when {
                    c.kind == ContentKind.FILTER && c.missing -> message = context.getString(R.string.widget_filter_missing)
                    c.filterError != null -> message = filterProblem(context, c)
                    c.missing -> message = context.getString(R.string.widget_project_missing)
                    c.count == 0 -> empty = true // "Geen taken – Wil je iets toevoegen?", zoals in Todoist
                }
            }
        }

        views.setTextViewText(R.id.title, title)
        // zoals in Todoist alleen de titel in de balk; de datum en het aantal staan wel in de tekst (voor TalkBack en de tests)
        views.setViewVisibility(R.id.subtitle, View.GONE)
        if (subtitle != null) views.setTextViewText(R.id.subtitle, subtitle)
        views.setContentDescription(R.id.header_text, context.getString(R.string.widget_choose_overview, description))

        val showList = message == null && !empty
        views.setViewVisibility(R.id.list, if (showList) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.message, if (message != null) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.empty_state, if (empty) View.VISIBLE else View.GONE)
        if (message != null) views.setTextViewText(R.id.message, message)
        if (empty) {
            views.setTextViewText(R.id.empty_title, context.getString(R.string.widget_empty_title))
            views.setTextViewText(R.id.empty_text, context.getString(R.string.widget_empty_text))
        }

        // "+" opent Taak toevoegen, in het project van deze lijst; zonder aanmelding opent het gewoon de app. De titel met het pijltje
        // opent de keuze van het overzicht, het beeldmerk de app.
        views.setOnClickPendingIntent(R.id.add, WidgetIntents.addTask(context, WidgetModel.addTarget(source, snapshot)))
        views.setOnClickPendingIntent(R.id.empty_state, WidgetIntents.addTask(context, WidgetModel.addTarget(source, snapshot)))
        views.setOnClickPendingIntent(R.id.logo, WidgetIntents.openApp(context))
        views.setOnClickPendingIntent(R.id.message, WidgetIntents.openApp(context))
        views.setOnClickPendingIntent(R.id.header_text, chooseOverview(context, appWidgetId))
        views.setOnClickPendingIntent(R.id.settings, settings(context, appWidgetId))

        val adapter = Intent(context, WidgetListService::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            // een eigen adres per widget: Android bewaart de lijst per intentie, en vergelijkt daarbij de extra's niet
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("list").appendPath(appWidgetId.toString()).build())
        views.setRemoteAdapter(R.id.list, adapter)
        views.setPendingIntentTemplate(R.id.list, WidgetIntents.itemTemplate(context, appWidgetId))
        return views
    }

    private fun todayLabel(context: Context): String {
        val today = Instant.ofEpochMilli(AppClock.now()).atZone(ZoneId.systemDefault()).toLocalDate()
        return DueText.dayMonth(today, today, WidgetModel.lang(context))
    }

    /** Het tandwiel in de balk (zoals in Todoist): alle instellingen van deze widget. */
    private fun settings(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, WidgetConfigActivity::class.java)
            .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("settings").appendPath(appWidgetId.toString()).build())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, 2000 + appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** Het pijltje bij de titel: het scherm om een ander overzicht te kiezen (Inbox, Vandaag, Aankomend, een project of een filter). */
    private fun chooseOverview(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, WidgetConfigActivity::class.java)
            .setAction(AppWidgetManager.ACTION_APPWIDGET_CONFIGURE)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .putExtra(WidgetConfigActivity.EXTRA_CHOOSE_ONLY, true)
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("choose").appendPath(appWidgetId.toString()).build())
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return PendingIntent.getActivity(context, 1000 + appWidgetId, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /**
     * Het uiterlijk dat per widget is gekozen: de kleuren van de achtergrond, de balk en de knoppen (het thema en de weergave) en de
     * doorzichtigheid. De regels (de lijst) lezen hetzelfde uit WidgetListService.
     */
    internal fun applyLook(views: RemoteViews, options: WidgetOptions, look: WidgetColors) {
        views.setInt(R.id.widget_bg, "setImageAlpha", options.alpha)
        views.setInt(R.id.widget_bg, "setColorFilter", look.background)
        views.setInt(R.id.toolbar_bg, "setImageAlpha", options.alpha)
        views.setInt(R.id.toolbar_bg, "setColorFilter", look.toolbar)
        views.setInt(R.id.logo, "setColorFilter", look.accent)
        views.setInt(R.id.chevron, "setColorFilter", look.textSoft)
        views.setInt(R.id.settings, "setColorFilter", look.textSoft)
        views.setInt(R.id.add_circle, "setColorFilter", look.accent)
        views.setTextColor(R.id.title, look.text)
        views.setTextColor(R.id.subtitle, look.textSoft)
        views.setTextColor(R.id.message, look.textSoft)
        views.setTextColor(R.id.empty_title, look.text)
        views.setTextColor(R.id.empty_text, look.textSoft)
        views.setInt(R.id.empty_icon, "setColorFilter", look.textFaint)
    }
}
