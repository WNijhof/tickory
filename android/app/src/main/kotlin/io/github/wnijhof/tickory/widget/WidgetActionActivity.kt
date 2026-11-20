package io.github.wnijhof.tickory.widget

import android.app.Activity
import android.content.ActivityNotFoundException
import android.os.Bundle
import android.util.Log
import android.content.Intent
import io.github.wnijhof.tickory.AppShortcuts
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.reminders.Notifications

/**
 * Ontvangt de tik op een regel van een lijstwidget. Heeft geen scherm: het doet wat gevraagd is en sluit meteen.
 * Afvinken vindt hier plaats (lokaal, in een paar milliseconden, de rest gaat via de wachtrij), een taak openen
 * toont het kleine venster van de taak (TaskPopupActivity). Alleen de widgets van de app kunnen dit aanroepen (exported="false"); het id wordt gecontroleerd.
 */
class WidgetActionActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        try {
            handle()
        } catch (e: RuntimeException) {
            Log.w("TickoryWidgets", "tik in widget afhandelen mislukt: ${e.javaClass.simpleName}") // geen taakinhoud in het logboek
        } finally {
            finish()
        }
    }

    /** Alleen de vaste overzichten die de app kent (de waarde komt uit ons eigen sjabloon, maar wordt toch gecontroleerd). */
    private fun openView(view: String?) {
        val known = setOf(DeepLink.VIEW_TODAY, DeepLink.VIEW_UPCOMING, DeepLink.VIEW_INBOX)
        val intent = if (view != null && view in known) {
            Intent(this, MainActivity::class.java).setAction(AppShortcuts.ACTION).putExtra(DeepLink.EXTRA_VIEW, view)
        } else {
            Intent(this, MainActivity::class.java).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        }
        try {
            startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
        } catch (_: ActivityNotFoundException) {
            // de app zelf ontbreekt niet; dit vangt alleen een rare toestand af
        }
    }

    private fun handle() {
        if (intent?.getStringExtra(WidgetIntents.EXTRA_KIND) == WidgetIntents.KIND_RESCHEDULE) {
            val ids = intent?.getStringArrayExtra(RescheduleActivity.EXTRA_TASK_IDS)?.filter(Ids::isSafeId)?.take(500) ?: return
            if (ids.isEmpty()) return
            try {
                startActivity(Intent(this, RescheduleActivity::class.java).putExtra(RescheduleActivity.EXTRA_TASK_IDS, ids.toTypedArray()).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            } catch (_: ActivityNotFoundException) {
                // de app zelf ontbreekt niet; dit vangt alleen een rare toestand af
            }
            return
        }
        if (intent?.getStringExtra(WidgetIntents.EXTRA_KIND) == WidgetIntents.KIND_VIEW) {
            openView(intent?.getStringExtra(WidgetIntents.EXTRA_TARGET_VIEW))
            return
        }
        val taskId = intent?.getStringExtra(Notifications.EXTRA_TASK_ID)?.takeIf(Ids::isSafeId) ?: return
        when (intent?.getStringExtra(WidgetIntents.EXTRA_KIND)) {
            WidgetIntents.KIND_COMPLETE -> WidgetActions.complete(this, taskId)
            WidgetIntents.KIND_UNDO -> WidgetActions.undo(this, taskId)
            // een tik op een taak: het kleine venster over het startscherm (zoals Todoist), niet de hele app
            WidgetIntents.KIND_OPEN -> try {
                startActivity(WidgetIntents.taskPopup(this, taskId))
            } catch (_: ActivityNotFoundException) {
                // de app zelf ontbreekt niet; dit vangt alleen een rare toestand af
            }
        }
    }
}
