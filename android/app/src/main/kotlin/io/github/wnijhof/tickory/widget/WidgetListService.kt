package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.ContentKind
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.WidgetColors
import io.github.wnijhof.tickory.core.WidgetContent
import io.github.wnijhof.tickory.core.WidgetContentBuilder
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.core.WidgetRow
import io.github.wnijhof.tickory.core.WidgetSize
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.store.WidgetConfigStore

/** Levert de regels van een lijstwidget. De bron is de intentie van de widget (alleen door Android zelf te binden: BIND_REMOTEVIEWS). */
class WidgetListService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        Factory(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))

    /** De laatste rij van een lange lijst: "Tik hier om de app te openen voor meer taken". */
    private object More

    /**
     * Leest bij elke verversing opnieuw de gegevens op het toestel (nooit het netwerk), en bouwt daar de regels van.
     * Een regel heeft twee tikvlakken: de cirkel (afvinken) en de tekst (de taak openen). De kop "Over tijd" heeft de knop Herplannen.
     */
    class Factory(private val context: Context, private val appWidgetId: Int) : RemoteViewsFactory {
        private var rows: List<Any> = emptyList()
        private var size = WidgetSize.MEDIUM
        private var options = WidgetOptions()
        private var look: WidgetColors = WidgetPalette.resolve(context, options)
        private var kind = ContentKind.TODAY

        override fun onCreate() {}

        override fun onDataSetChanged() {
            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                rows = emptyList()
                return
            }
            val manager = AppWidgetManager.getInstance(context)
            size = ListWidgets.sizeOf(manager, appWidgetId)
            options = WidgetConfigStore.options(context, appWidgetId)
            look = WidgetPalette.resolve(context, options)
            val state = WidgetModel.state(context, ListWidgets.storedSource(context, appWidgetId))
            val content = (state as? WidgetModel.State.Ready)?.content
            kind = content?.kind ?: ContentKind.TODAY
            rows = withMore(content)
        }

        /** De regels, met onderaan "meer taken" als er meer taken zijn dan regels. */
        private fun withMore(content: WidgetContent?): List<Any> {
            val list = content?.rows ?: return emptyList()
            val shown = list.count { it is WidgetRow.Item }
            return if (content.count > shown) list + More else list
        }

        override fun onDestroy() {
            rows = emptyList()
        }

        override fun getCount(): Int = rows.size

        override fun getViewAt(position: Int): RemoteViews? = when (val row = rows.getOrNull(position)) {
            is WidgetRow.Header -> header(row)
            is WidgetRow.Item -> item(row)
            More -> more()
            else -> null
        }

        private fun scaled(sp: Float): Float = sp * options.font.scale

        private fun header(row: WidgetRow.Header): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_item_header)
            views.setTextViewText(R.id.header_label, if (row.overdue) context.getString(R.string.widget_overdue_header) else row.text)
            views.setTextColor(R.id.header_label, look.text)
            views.setTextViewTextSize(R.id.header_label, TypedValue.COMPLEX_UNIT_SP, scaled(14f))
            views.setViewVisibility(R.id.header_button, if (row.overdue) View.VISIBLE else View.GONE)
            if (row.overdue) {
                views.setTextViewText(R.id.header_button, context.getString(R.string.widget_reschedule))
                views.setTextColor(R.id.header_button, look.accent)
                views.setTextViewTextSize(R.id.header_button, TypedValue.COMPLEX_UNIT_SP, scaled(13f))
                // Herplannen: de app op Vandaag, waar je alle te late taken in één keer naar een andere dag zet
                views.setOnClickFillInIntent(R.id.header_button, WidgetIntents.fillInView(DeepLink.VIEW_TODAY))
            }
            return views
        }

        private fun more(): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_item_more)
            views.setTextViewText(R.id.more_text, context.getString(R.string.widget_more_tasks))
            views.setTextColor(R.id.more_text, look.textSoft)
            views.setTextViewTextSize(R.id.more_text, TypedValue.COMPLEX_UNIT_SP, scaled(13f))
            views.setInt(R.id.more_icon, "setColorFilter", look.textSoft)
            val view = when (kind) {
                ContentKind.TODAY -> DeepLink.VIEW_TODAY
                ContentKind.UPCOMING -> DeepLink.VIEW_UPCOMING
                else -> null
            }
            views.setOnClickFillInIntent(R.id.more_root, WidgetIntents.fillInView(view))
            return views
        }

        private fun item(row: WidgetRow.Item): RemoteViews {
            val compact = options.compact
            val views = RemoteViews(context.packageName, if (compact) R.layout.widget_item_compact else R.layout.widget_item)
            val title = row.title.ifBlank { context.getString(R.string.task_untitled) }
            views.setTextViewText(R.id.item_title, title)
            views.setTextColor(R.id.item_title, look.text)
            views.setTextViewTextSize(R.id.item_title, TypedValue.COMPLEX_UNIT_SP, scaled(14f))
            // de cirkel in de kleur van de prioriteit; alleen lezen: geen cirkel (afvinken zou de server weigeren), de plek blijft
            views.setImageViewResource(R.id.check, R.drawable.widget_check_p4)
            views.setInt(R.id.check, "setColorFilter", look.priority(row.priority))
            views.setViewVisibility(R.id.check, if (row.readOnly) View.INVISIBLE else View.VISIBLE)

            val dueColor = look.dueColor(row.dueKind)
            if (compact) {
                // compact: één regel, de datum rechts uitgelijnd; geen tweede regel en geen project
                views.setTextViewText(R.id.item_due, row.due ?: "")
                views.setViewVisibility(R.id.item_due, if (row.due != null) View.VISIBLE else View.GONE)
                views.setTextColor(R.id.item_due, dueColor)
                views.setTextViewTextSize(R.id.item_due, TypedValue.COMPLEX_UNIT_SP, scaled(12f))
            } else {
                attributes(views, row, dueColor)
            }
            val indent = row.depth * context.resources.getDimensionPixelSize(R.dimen.widget_indent)
            views.setViewPadding(R.id.item_root, indent + context.resources.getDimensionPixelSize(R.dimen.widget_item_start), 0, 0, 0)

            // Voor TalkBack: wat een tik doet, met de naam van de taak erbij.
            views.setContentDescription(R.id.check, context.getString(R.string.widget_complete_task, title))
            views.setContentDescription(R.id.text_area, context.getString(R.string.widget_open_task, title))
            val (complete, open) = clickIntents(row)
            views.setOnClickFillInIntent(R.id.check, complete)
            views.setOnClickFillInIntent(R.id.text_area, open)
            return views
        }

        /** De tweede regel: subtaken, datum (met herhaling), deadline, herinnering, labels, en rechts het project. */
        private fun attributes(views: RemoteViews, row: WidgetRow.Item, dueColor: Int) {
            val small = scaled(11f)
            fun visible(id: Int, on: Boolean) = views.setViewVisibility(id, if (on) View.VISIBLE else View.GONE)
            fun tint(id: Int, color: Int) = views.setInt(id, "setColorFilter", color)

            visible(R.id.icon_subtasks, row.subtasks > 0)
            visible(R.id.item_subtasks, row.subtasks > 0)
            if (row.subtasks > 0) {
                tint(R.id.icon_subtasks, look.textSoft)
                views.setTextViewText(R.id.item_subtasks, row.subtasks.toString())
                views.setTextColor(R.id.item_subtasks, look.textSoft)
                views.setTextViewTextSize(R.id.item_subtasks, TypedValue.COMPLEX_UNIT_SP, small)
            }
            visible(R.id.icon_due, row.due != null)
            visible(R.id.item_due, row.due != null)
            if (row.due != null) {
                tint(R.id.icon_due, dueColor)
                views.setTextViewText(R.id.item_due, row.due)
                views.setTextColor(R.id.item_due, dueColor)
                views.setTextViewTextSize(R.id.item_due, TypedValue.COMPLEX_UNIT_SP, small)
            }
            visible(R.id.icon_recurring, row.due != null && row.recurring)
            if (row.recurring) tint(R.id.icon_recurring, dueColor)
            visible(R.id.icon_deadline, row.deadline)
            if (row.deadline) tint(R.id.icon_deadline, look.textSoft)
            visible(R.id.icon_reminder, row.reminder)
            if (row.reminder) tint(R.id.icon_reminder, look.textSoft)
            visible(R.id.item_labels, row.labels != null)
            if (row.labels != null) {
                views.setTextViewText(R.id.item_labels, row.labels)
                views.setTextColor(R.id.item_labels, look.textSoft)
                views.setTextViewTextSize(R.id.item_labels, TypedValue.COMPLEX_UNIT_SP, small)
            }
            // het project staat rechts: de Inbox met het pictogram van de Inbox, een ander project met een #
            val project = row.project
            visible(R.id.icon_project, project != null)
            visible(R.id.item_project, project != null)
            if (project != null) {
                views.setImageViewResource(R.id.icon_project, if (row.inbox) R.drawable.ic_attr_inbox else R.drawable.ic_attr_hash)
                tint(R.id.icon_project, look.textSoft)
                views.setTextViewText(R.id.item_project, project)
                views.setTextColor(R.id.item_project, look.textSoft)
                views.setTextViewTextSize(R.id.item_project, TypedValue.COMPLEX_UNIT_SP, small)
            }
            val any = row.subtasks > 0 || row.due != null || row.deadline || row.reminder || row.labels != null || project != null
            visible(R.id.item_line2, any)
        }

        /** Wat de twee tikvlakken van een regel aan het sjabloon toevoegen: eerst de cirkel (afvinken), dan de tekst (openen). */
        internal fun clickIntents(row: WidgetRow.Item): Pair<Intent, Intent> =
            WidgetIntents.fillIn(if (row.readOnly) WidgetIntents.KIND_OPEN else WidgetIntents.KIND_COMPLETE, row.id) to WidgetIntents.fillIn(WidgetIntents.KIND_OPEN, row.id)

        override fun getLoadingView(): RemoteViews? = null

        override fun getViewTypeCount(): Int = 4

        override fun getItemId(position: Int): Long = when (val row = rows.getOrNull(position)) {
            is WidgetRow.Item -> row.id.hashCode().toLong()
            is WidgetRow.Header -> "h:${row.text}".hashCode().toLong()
            More -> "more".hashCode().toLong()
            else -> 0L
        }

        override fun hasStableIds(): Boolean = true

        companion object {
            private val CHECK_ICONS = intArrayOf(R.drawable.widget_check_p1, R.drawable.widget_check_p2, R.drawable.widget_check_p3, R.drawable.widget_check_p4)

            /** De cirkel in de kleur van de prioriteit (1 = hoogst … 4 = geen); iets anders wordt 4. */
            internal fun checkIcon(priority: Int): Int = CHECK_ICONS[(if (priority in 1..4) priority else 4) - 1]
        }
    }
}
