package io.github.wnijhof.tickory.widget

import android.appwidget.AppWidgetManager
import android.content.Context
import android.content.Intent
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.WidgetRow
import io.github.wnijhof.tickory.core.WidgetSize

/** Levert de regels van een lijstwidget. De bron is de intentie van de widget (alleen door Android zelf te binden: BIND_REMOTEVIEWS). */
class WidgetListService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        Factory(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))

    /**
     * Leest bij elke verversing opnieuw de gegevens op het toestel (nooit het netwerk), en bouwt daar de regels van.
     * Een regel heeft twee tikvlakken: de cirkel (afvinken) en de tekst (de taak openen).
     */
    class Factory(private val context: Context, private val appWidgetId: Int) : RemoteViewsFactory {
        private var rows: List<WidgetRow> = emptyList()
        private var size = WidgetSize.MEDIUM

        override fun onCreate() {}

        override fun onDataSetChanged() {
            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                rows = emptyList()
                return
            }
            val manager = AppWidgetManager.getInstance(context)
            size = ListWidgets.sizeOf(manager, appWidgetId)
            val state = WidgetModel.state(context, ListWidgets.storedSource(context, appWidgetId))
            rows = (state as? WidgetModel.State.Ready)?.content?.rows ?: emptyList()
        }

        override fun onDestroy() {
            rows = emptyList()
        }

        override fun getCount(): Int = rows.size

        override fun getViewAt(position: Int): RemoteViews? {
            val row = rows.getOrNull(position) ?: return null
            return when (row) {
                is WidgetRow.Header -> header(row)
                is WidgetRow.Item -> item(row)
            }
        }

        private fun header(row: WidgetRow.Header): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_item_header)
            views.setTextViewText(R.id.header_label, row.text)
            return views
        }

        private fun item(row: WidgetRow.Item): RemoteViews {
            val views = RemoteViews(context.packageName, R.layout.widget_item)
            val title = row.title.ifBlank { context.getString(R.string.task_untitled) }
            views.setTextViewText(R.id.item_title, title)
            views.setTextViewTextSize(R.id.item_title, TypedValue.COMPLEX_UNIT_SP, if (size == WidgetSize.LARGE) 16f else 14f)
            views.setImageViewResource(R.id.check, checkIcon(row.priority))
            // alleen lezen: geen cirkel (afvinken zou de server weigeren); de plek blijft, zodat de regels netjes onder elkaar staan
            views.setViewVisibility(R.id.check, if (row.readOnly) View.INVISIBLE else View.VISIBLE)

            // De tweede regel (datum en project) alleen als er plek is: in een klein formaat telt elke regel.
            val showSecondLine = size != WidgetSize.SMALL && (row.due != null || row.meta != null)
            views.setViewVisibility(R.id.item_line2, if (showSecondLine) View.VISIBLE else View.GONE)
            if (showSecondLine) {
                val due = row.due
                views.setTextViewText(R.id.item_due, if (due != null && row.meta != null) "$due · " else due ?: "")
                views.setTextColor(R.id.item_due, context.getColor(if (row.overdue) R.color.widget_overdue else R.color.widget_text_soft))
                views.setTextViewText(R.id.item_meta, row.meta ?: "")
            }
            val indent = (row.depth * context.resources.getDimensionPixelSize(R.dimen.widget_indent))
            views.setViewPadding(R.id.item_root, indent + context.resources.getDimensionPixelSize(R.dimen.widget_item_start), 0, 0, 0)

            // Voor TalkBack: wat een tik doet, met de naam van de taak erbij.
            views.setContentDescription(R.id.check, context.getString(R.string.widget_complete_task, title))
            views.setContentDescription(R.id.text_area, context.getString(R.string.widget_open_task, title))
            val (complete, open) = clickIntents(row)
            views.setOnClickFillInIntent(R.id.check, complete)
            views.setOnClickFillInIntent(R.id.text_area, open)
            return views
        }

        /** Wat de twee tikvlakken van een regel aan het sjabloon toevoegen: eerst de cirkel (afvinken), dan de tekst (openen). */
        internal fun clickIntents(row: WidgetRow.Item): Pair<Intent, Intent> =
            WidgetIntents.fillIn(if (row.readOnly) WidgetIntents.KIND_OPEN else WidgetIntents.KIND_COMPLETE, row.id) to WidgetIntents.fillIn(WidgetIntents.KIND_OPEN, row.id)

        override fun getLoadingView(): RemoteViews? = null

        override fun getViewTypeCount(): Int = 2

        override fun getItemId(position: Int): Long = (rows.getOrNull(position)?.let { if (it is WidgetRow.Item) it.id else "h:${(it as WidgetRow.Header).text}" } ?: "").hashCode().toLong()

        override fun hasStableIds(): Boolean = true

        companion object {
            private val CHECK_ICONS = intArrayOf(R.drawable.widget_check_p1, R.drawable.widget_check_p2, R.drawable.widget_check_p3, R.drawable.widget_check_p4)

            /** De cirkel in de kleur van de prioriteit (1 = hoogst … 4 = geen); iets anders wordt 4. */
            internal fun checkIcon(priority: Int): Int = CHECK_ICONS[(if (priority in 1..4) priority else 4) - 1]
        }
    }
}
