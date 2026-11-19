package io.github.wnijhof.tickory.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.TypedValue
import android.view.View
import android.widget.RemoteViews
import android.widget.RemoteViewsService
import io.github.wnijhof.tickory.AppShortcuts
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.NoteReminders
import io.github.wnijhof.tickory.core.WidgetNote
import io.github.wnijhof.tickory.core.WidgetSize
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler

/**
 * De widget Notities: je notities als kaartjes in hun eigen kleur, vastgepinde eerst en daarna de laatst gewijzigde, met de kop,
 * een paar regels tekst en hoeveel punten van een checklist af zijn. Een tik opent de notitie in de app, "+" maakt een nieuwe,
 * de kop opent de notities. Alleen de gegevens op het toestel (de verversing op de achtergrond haalt ze op), en nooit iets van een
 * vorige gebruiker: zonder (geldige) aanmelding of zolang niet vaststaat van wie de gegevens zijn, staat er geen notitie.
 */
class NotesWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, manager: AppWidgetManager, appWidgetIds: IntArray) {
        NotesWidget.update(context, manager, appWidgetIds)
    }

    override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, appWidgetId: Int, newOptions: Bundle?) {
        NotesWidget.update(context, manager, intArrayOf(appWidgetId))
    }

    override fun onEnabled(context: Context) {
        if (Session.isActive(context)) SyncScheduler.refreshNow(context)
    }
}

object NotesWidget {
    sealed class State {
        object SignedOut : State()
        object Expired : State()
        object Loading : State()
        data class Ready(val notes: List<WidgetNote>) : State()
    }

    fun state(context: Context): State {
        val app = context.applicationContext
        val prefs = Prefs(app)
        if (prefs.serverOrigin == null || prefs.encryptedToken == null) return State.SignedOut
        if (prefs.sessionExpired) return State.Expired
        if (!Session.isActive(app)) return State.SignedOut
        val snapshot = WidgetStore.visibleSnapshot(app) ?: return State.Loading
        return State.Ready(snapshot.notes)
    }

    @Suppress("DEPRECATION") // zie ListWidgets.update: de oudere vorm met een RemoteViewsService
    fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
        for (id in ids) manager.updateAppWidget(id, render(context, manager, id))
        manager.notifyAppWidgetViewDataChanged(ids, R.id.list)
    }

    @Suppress("DEPRECATION")
    fun render(context: Context, manager: AppWidgetManager, appWidgetId: Int): RemoteViews {
        val views = RemoteViews(context.packageName, R.layout.widget_list)
        val size = ListWidgets.sizeOf(manager, appWidgetId)
        val title = context.getString(R.string.widget_title_notes)
        views.setTextViewTextSize(R.id.title, TypedValue.COMPLEX_UNIT_SP, when (size) { WidgetSize.SMALL -> 15f; WidgetSize.MEDIUM -> 18f; WidgetSize.LARGE -> 20f })
        var subtitle: String? = null
        var message: String? = null
        when (val state = state(context)) {
            State.SignedOut -> message = context.getString(R.string.widget_signed_out)
            State.Expired -> message = context.getString(R.string.widget_expired)
            State.Loading -> message = context.getString(R.string.widget_loading)
            is State.Ready -> {
                val n = state.notes.size
                subtitle = context.resources.getQuantityString(R.plurals.widget_note_count, n, n)
                if (n == 0) message = context.getString(R.string.widget_empty_notes)
            }
        }
        if (size == WidgetSize.SMALL || subtitle == null) {
            views.setTextViewText(R.id.title, title)
            views.setViewVisibility(R.id.subtitle, View.GONE)
        } else {
            views.setTextViewText(R.id.title, title)
            views.setViewVisibility(R.id.subtitle, View.VISIBLE)
            views.setTextViewText(R.id.subtitle, subtitle)
        }
        views.setContentDescription(R.id.header_text, if (subtitle != null) "$title, $subtitle" else title)
        views.setViewVisibility(R.id.list, if (message == null) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.message, if (message != null) View.VISIBLE else View.GONE)
        if (message != null) views.setTextViewText(R.id.message, message)

        // "+" maakt een nieuwe notitie in de app; de kop en de melding openen de notities
        views.setContentDescription(R.id.add, context.getString(R.string.widget_new_note))
        views.setOnClickPendingIntent(R.id.add, newNote(context))
        views.setOnClickPendingIntent(R.id.header_text, openNotes(context))
        views.setOnClickPendingIntent(R.id.message, openNotes(context))

        val adapter = Intent(context, NotesWidgetService::class.java)
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, appWidgetId)
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("notes").appendPath(appWidgetId.toString()).build())
        views.setRemoteAdapter(R.id.list, adapter)
        views.setPendingIntentTemplate(R.id.list, WidgetIntents.itemTemplate(context, appWidgetId))
        return views
    }

    /** De app openen bij een vaste plek (zoals de snelkoppelingen onder het app-icoon): de notities, of een nieuwe notitie. */
    private fun openView(context: Context, view: String, request: Int): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(AppShortcuts.ACTION)
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("view").appendPath(view).build())
            .putExtra(DeepLink.EXTRA_VIEW, view)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, request, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** De "+": het kleine venster Notitie toevoegen over het startscherm, op dezelfde manier als de "+" van een takenlijst. */
    fun newNote(context: Context): PendingIntent = WidgetIntents.addNote(context)

    fun openNotes(context: Context): PendingIntent = openView(context, DeepLink.VIEW_NOTES, REQUEST_OPEN_NOTES)

    /** De kleur van een kaart bij een achtergrond van de notitie (licht en donker staan in de kleurbronnen); null = de gewone kaart. */
    fun colorRes(background: String?): Int = when (background) {
        "yellow" -> R.color.widget_note_yellow
        "orange" -> R.color.widget_note_orange
        "brown" -> R.color.widget_note_brown
        "red" -> R.color.widget_note_red
        "pink" -> R.color.widget_note_pink
        "purple" -> R.color.widget_note_purple
        "indigo" -> R.color.widget_note_indigo
        "blue" -> R.color.widget_note_blue
        "teal" -> R.color.widget_note_teal
        "green" -> R.color.widget_note_green
        "dots" -> R.color.widget_note_dots
        "grid" -> R.color.widget_note_grid
        "lines" -> R.color.widget_note_lines
        "waves" -> R.color.widget_note_waves
        "groceries" -> R.color.widget_note_groceries
        "music" -> R.color.widget_note_music
        "travel" -> R.color.widget_note_travel
        "code" -> R.color.widget_note_code
        else -> R.color.widget_note_card
    }

    private const val REQUEST_NEW_NOTE = 3
    private const val REQUEST_OPEN_NOTES = 4
}

/** Levert de kaartjes van de notitiewidget (alleen door Android zelf te binden: BIND_REMOTEVIEWS). */
class NotesWidgetService : RemoteViewsService() {
    override fun onGetViewFactory(intent: Intent): RemoteViewsFactory =
        Factory(applicationContext, intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID))

    class Factory(private val context: Context, private val appWidgetId: Int) : RemoteViewsFactory {
        private var notes: List<WidgetNote> = emptyList()
        private var size = WidgetSize.MEDIUM

        override fun onCreate() {}

        override fun onDataSetChanged() {
            if (appWidgetId == AppWidgetManager.INVALID_APPWIDGET_ID) {
                notes = emptyList()
                return
            }
            size = ListWidgets.sizeOf(AppWidgetManager.getInstance(context), appWidgetId)
            notes = (NotesWidget.state(context) as? NotesWidget.State.Ready)?.notes ?: emptyList()
        }

        override fun onDestroy() {
            notes = emptyList()
        }

        override fun getCount(): Int = notes.size

        override fun getViewAt(position: Int): RemoteViews? {
            val note = notes.getOrNull(position) ?: return null
            val views = RemoteViews(context.packageName, R.layout.widget_note)
            val title = note.title.ifBlank { context.getString(R.string.widget_note_untitled) }
            views.setTextViewText(R.id.note_title, title)
            views.setViewVisibility(R.id.note_pin, if (note.pinned) View.VISIBLE else View.GONE)
            // klein: alleen de kop en de stand van de checklist; anders ook een paar regels tekst
            val showExcerpt = size != WidgetSize.SMALL && note.excerpt.isNotBlank()
            views.setViewVisibility(R.id.note_excerpt, if (showExcerpt) View.VISIBLE else View.GONE)
            if (showExcerpt) {
                views.setTextViewText(R.id.note_excerpt, note.excerpt)
                views.setInt(R.id.note_excerpt, "setMaxLines", if (size == WidgetSize.LARGE) 6 else 3)
            }
            val meta = listOfNotNull(
                if (note.total > 0) context.getString(R.string.widget_note_checklist, note.done, note.total) else null,
                if (note.shared) context.getString(R.string.widget_note_shared) else null,
            ).joinToString(" · ")
            views.setViewVisibility(R.id.note_meta, if (meta.isNotEmpty()) View.VISIBLE else View.GONE)
            views.setTextViewText(R.id.note_meta, meta)
            // de kleur van de notitie: vanaf Android 12 een tint op de afgeronde kaart (licht en donker volgen het toestel), daarvoor
            // een gewone achtergrondkleur
            val color = NotesWidget.colorRes(note.background)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                views.setColorStateList(R.id.note_card, "setBackgroundTintList", color)
            } else {
                views.setInt(R.id.note_card, "setBackgroundColor", context.getColor(color))
            }
            views.setContentDescription(R.id.note_card, context.getString(R.string.widget_open_note, title))
            views.setOnClickFillInIntent(R.id.note_card, fillIn(note))
            return views
        }

        /** Wat een tik aan het sjabloon toevoegt: de notitie openen (via de "taak" van een notitie, zie NoteReminders en DeepLink). */
        internal fun fillIn(note: WidgetNote): Intent = WidgetIntents.fillIn(WidgetIntents.KIND_OPEN, NoteReminders.taskIdFor(note.id))

        override fun getLoadingView(): RemoteViews? = null

        override fun getViewTypeCount(): Int = 1

        override fun getItemId(position: Int): Long = (notes.getOrNull(position)?.id ?: "").hashCode().toLong()

        override fun hasStableIds(): Boolean = true
    }
}
