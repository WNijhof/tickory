package io.github.wnijhof.tickory.widget

import android.app.Activity
import android.content.ActivityNotFoundException
import android.os.Bundle
import android.util.Log
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.reminders.Notifications

/**
 * Ontvangt de tik op een regel van een lijstwidget. Heeft geen scherm: het doet wat gevraagd is en sluit meteen.
 * Afvinken vindt hier plaats (lokaal, in een paar milliseconden, de rest gaat via de wachtrij), een taak openen
 * start de app. Alleen de widgets van de app kunnen dit aanroepen (exported="false"); het id wordt gecontroleerd.
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

    private fun handle() {
        val taskId = intent?.getStringExtra(Notifications.EXTRA_TASK_ID)?.takeIf(Ids::isSafeId) ?: return
        when (intent?.getStringExtra(WidgetIntents.EXTRA_KIND)) {
            WidgetIntents.KIND_COMPLETE -> WidgetActions.complete(this, taskId)
            WidgetIntents.KIND_OPEN -> try {
                startActivity(WidgetIntents.openTask(this, taskId))
            } catch (_: ActivityNotFoundException) {
                // de app zelf ontbreekt niet; dit vangt alleen een rare toestand af
            }
        }
    }
}
