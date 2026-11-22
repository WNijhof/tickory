package io.github.wnijhof.tickory.widget

import android.content.Context
import android.util.TypedValue
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.ListView
import android.widget.TextView
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DueKind
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.WidgetColors
import io.github.wnijhof.tickory.core.WidgetOptions
import io.github.wnijhof.tickory.reminders.AppClock
import java.time.Instant
import java.time.LocalTime
import java.time.ZoneId

/**
 * Het voorbeeld bovenaan de instellingen van een lijstwidget, zoals in Todoist: de balk en drie voorbeeldtaken, getekend met het thema,
 * de weergave, de lettergrootte, de doorzichtigheid en de compacte weergave die nu zijn gekozen. Het gebruikt dezelfde layouts als de
 * widget zelf (maar als gewone views, in plaats van via RemoteViews), met vaste voorbeeldtaken: er zijn geen gegevens van de gebruiker voor nodig.
 */
object WidgetPreview {
    private class Sample(val title: String, val due: String?, val kind: DueKind, val priority: Int, val subtasks: Int, val project: String?, val recurring: Boolean = false)

    /** Teken het voorbeeld in [container] (eerder getekende inhoud verdwijnt). */
    fun render(context: Context, container: FrameLayout, options: WidgetOptions, title: String) {
        container.removeAllViews()
        val look = WidgetPalette.resolve(context, options)
        val root = LayoutInflater.from(context).inflate(R.layout.widget_list, container, false)
        container.addView(root)
        val scale = options.font.scale
        root.findViewById<ImageView>(R.id.widget_bg).apply { imageAlpha = options.alpha; setColorFilter(look.background) }
        root.findViewById<ImageView>(R.id.toolbar_bg).apply { imageAlpha = options.alpha; setColorFilter(look.toolbar) }
        root.findViewById<ImageView>(R.id.logo).setColorFilter(look.accent)
        root.findViewById<ImageView>(R.id.chevron).setColorFilter(look.textSoft)
        root.findViewById<ImageView>(R.id.settings).setColorFilter(look.textSoft)
        root.findViewById<ImageView>(R.id.add_circle).setColorFilter(look.accent)
        root.findViewById<TextView>(R.id.title).apply { text = title; setTextColor(look.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, 16f * scale) }
        root.findViewById<View>(R.id.subtitle).visibility = View.GONE
        root.findViewById<View>(R.id.empty_state).visibility = View.GONE
        root.findViewById<View>(R.id.message).visibility = View.GONE

        val zone = ZoneId.systemDefault()
        val lang = WidgetModel.lang(context)
        val today = Instant.ofEpochMilli(AppClock.now()).atZone(zone).toLocalDate()
        val samples = listOf(
            Sample(context.getString(R.string.widget_preview_task_1), DueText.format(today.minusDays(1).toString(), AppClock.now(), zone, lang), DueKind.OVERDUE, 1, 0, context.getString(R.string.widget_title_inbox)),
            Sample(context.getString(R.string.widget_preview_task_2), DueText.clock(LocalTime.of(14, 0), lang), DueKind.TODAY, 2, 2, context.getString(R.string.widget_preview_project)),
            Sample(context.getString(R.string.widget_preview_task_3), DueText.format(today.plusDays(1).toString(), AppClock.now(), zone, lang), DueKind.TOMORROW, 4, 0, null, recurring = true),
        )
        val list = root.findViewById<ListView>(R.id.list)
        list.isEnabled = false
        list.adapter = object : BaseAdapter() {
            override fun getCount() = samples.size
            override fun getItem(position: Int) = samples[position]
            override fun getItemId(position: Int) = position.toLong()
            override fun getView(position: Int, convertView: View?, parent: ViewGroup): View = row(context, parent, samples[position], options, look)
        }
    }

    private fun row(context: Context, parent: ViewGroup, s: Sample, options: WidgetOptions, look: WidgetColors): View {
        val compact = options.compact
        val view = LayoutInflater.from(context).inflate(if (compact) R.layout.widget_item_compact else R.layout.widget_item, parent, false)
        val scale = options.font.scale
        view.findViewById<TextView>(R.id.item_title).apply { text = s.title; setTextColor(look.text); setTextSize(TypedValue.COMPLEX_UNIT_SP, (if (compact) 13f else 14f) * scale) }
        val dueColor = look.dueColor(s.kind)
        val due = view.findViewById<TextView>(R.id.item_due)
        if (compact) {
            due.apply { text = s.due; setTextColor(dueColor); setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f * scale) }
            view.findViewById<ImageView>(R.id.icon_recurring).apply { visibility = if (s.recurring) View.VISIBLE else View.GONE; setColorFilter(dueColor) }
            view.findViewById<ImageView>(R.id.icon_priority).apply { visibility = if (s.priority in 1..3) View.VISIBLE else View.GONE; setColorFilter(look.priority(s.priority)) }
            return view
        }
        view.findViewById<ImageView>(R.id.check).setColorFilter(look.priority(s.priority))
        fun show(id: Int, on: Boolean) { view.findViewById<View>(id).visibility = if (on) View.VISIBLE else View.GONE }
        fun tint(id: Int, color: Int) = view.findViewById<ImageView>(id).setColorFilter(color)
        val small = 11f * scale
        show(R.id.icon_subtasks, s.subtasks > 0)
        show(R.id.item_subtasks, s.subtasks > 0)
        if (s.subtasks > 0) {
            tint(R.id.icon_subtasks, look.textSoft)
            view.findViewById<TextView>(R.id.item_subtasks).apply { text = context.getString(R.string.widget_subtasks_count, 1, s.subtasks); setTextColor(look.textSoft); setTextSize(TypedValue.COMPLEX_UNIT_SP, small) }
        }
        tint(R.id.icon_due, dueColor)
        due.apply { text = s.due; setTextColor(dueColor); setTextSize(TypedValue.COMPLEX_UNIT_SP, small) }
        show(R.id.icon_recurring, s.recurring)
        tint(R.id.icon_recurring, dueColor)
        show(R.id.icon_deadline, false)
        show(R.id.icon_reminder, false)
        show(R.id.item_reminders, false)
        show(R.id.icon_description, false)
        show(R.id.icon_comments, false)
        show(R.id.item_comments, false)
        show(R.id.item_labels, false)
        show(R.id.icon_project, s.project != null)
        show(R.id.item_project, s.project != null)
        if (s.project != null) {
            tint(R.id.icon_project, look.textSoft)
            view.findViewById<TextView>(R.id.item_project).apply { text = s.project; setTextColor(look.textSoft); setTextSize(TypedValue.COMPLEX_UNIT_SP, small) }
        }
        return view
    }
}
