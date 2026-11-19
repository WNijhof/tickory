package io.github.wnijhof.tickory

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.quicknote.QuickNoteActivity

/**
 * De snelkoppelingen onder het app-icoon (lang indrukken in de launcher): Taak toevoegen (het kleine venster, zoals de tegel),
 * Vandaag en Nieuwe notitie (het kleine venster Notitie toevoegen). Ze worden bij elke start van de app opnieuw gezet: zo wijzen de intenties altijd naar dit pakket
 * en volgen de namen de taal van het toestel. Ze geven alleen een vaste keuze mee (DeepLink.EXTRA_VIEW), nooit gegevens.
 */
object AppShortcuts {
    const val ADD = "add"
    const val TODAY = "today"
    const val NOTE = "note"
    private val ORDER = listOf(ADD, TODAY, NOTE)

    /** De actie van de intenties: geen VIEW, want die hoort in MainActivity bij de terugkeer van de inlogdienst. */
    const val ACTION = "io.github.wnijhof.tickory.action.SHORTCUT"

    fun build(context: Context): List<ShortcutInfoCompat> {
        fun open(view: String) = Intent(context, MainActivity::class.java).setAction(ACTION).putExtra(DeepLink.EXTRA_VIEW, view)
        fun shortcut(id: String, short: Int, long: Int, icon: Int, intent: Intent) =
            ShortcutInfoCompat.Builder(context, id)
                .setRank(ORDER.indexOf(id)) // de volgorde in het menu
                .setShortLabel(context.getString(short))
                .setLongLabel(context.getString(long))
                .setIcon(IconCompat.createWithResource(context, icon))
                .setIntent(intent)
                .build()
        return listOf(
            shortcut(ADD, R.string.shortcut_add_short, R.string.shortcut_add_long, R.drawable.ic_shortcut_add, AddTaskTileService.launchIntent(context).setAction(ACTION)),
            shortcut(TODAY, R.string.shortcut_today_short, R.string.shortcut_today_long, R.drawable.ic_shortcut_today, open(DeepLink.VIEW_TODAY)),
            shortcut(NOTE, R.string.shortcut_note_short, R.string.shortcut_note_long, R.drawable.ic_shortcut_note, QuickNoteActivity.launchIntent(context).setAction(ACTION)),
        )
    }

    /** Zet de snelkoppelingen; een launcher zonder snelkoppelingen (of een fout daarin) houdt de app niet tegen. */
    fun publish(context: Context) {
        try {
            ShortcutManagerCompat.setDynamicShortcuts(context, build(context))
        } catch (e: Exception) {
            // geen snelkoppelingen: de app werkt gewoon
        }
    }
}
