package io.github.wnijhof.tickory.widget

import android.content.Context
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.core.WidgetContentBuilder
import io.github.wnijhof.tickory.core.WidgetQueue
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.reminders.ReminderEngine
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import io.github.wnijhof.tickory.sync.SyncScheduler

/** Wat een tik in een widget doet. */
object WidgetActions {
    enum class Result {
        /** Afgevinkt en in de wachtrij gezet; de taak is uit de widget verdwenen. */
        QUEUED,

        /** Voor deze taak wachtte al een afvinkactie (dubbel tikken): niets gedaan. */
        ALREADY_QUEUED,

        /** Niet aangemeld, een onbruikbaar id, of de taak staat niet (meer) in de gegevens: alleen de widget verversen. */
        IGNORED,
    }

    /**
     * Vinkt een taak af vanuit een widget, ook zonder internet.
     *
     * De taak verdwijnt meteen uit alle widgets (hij staat in de wachtrij en de widgets verbergen wat daarin staat). Er
     * wordt niets aan de bewaarde gegevens verzonnen: bij een terugkerende taak weet alleen de server de volgende datum,
     * die komt bij de eerstvolgende verversing. De wachtrij gaat naar de server zodra er verbinding is, met een uuid per
     * actie (dus hooguit één keer uitgevoerd, ook bij opnieuw proberen of dubbel tikken); WorkManager herhaalt dat bij fouten.
     * Herinneringen, uitstel en meldingen van de taak vervallen meteen.
     */
    fun complete(context: Context, taskId: String?): Result {
        val app = context.applicationContext
        val id = taskId?.takeIf(Ids::isSafeId) ?: return Result.IGNORED
        if (!Session.isActive(app)) return Result.IGNORED
        val snapshot = WidgetStore.visibleSnapshot(app) ?: return Result.IGNORED
        val task = snapshot.tasks.firstOrNull { it.id == id }
        if (task == null || snapshot.project(task.projectId)?.readOnly == true) {
            WidgetUpdater.updateAll(app) // de widget liep achter (of de taak is alleen te lezen): laat zien hoe het nu is
            return Result.IGNORED
        }
        val item = QueuedComplete(
            taskId = task.id,
            uuid = WidgetQueue.newUuid(),
            ifDue = if (task.recurring) task.due else null,
            accountId = snapshot.accountId,
            queuedAtMs = AppClock.now(),
        )
        if (!WidgetStore.enqueue(app, item)) return Result.ALREADY_QUEUED

        // Alles wat met de taak meegaat: bij een gewone taak ook de subtaken (de server sluit die mee).
        val affected = if (task.recurring) setOf(task.id) else WidgetContentBuilder.hideWithSubtasks(snapshot, setOf(task.id))
        ReminderEngine.onCompletedLocally(app, affected)
        WidgetUpdater.updateAll(app)
        SyncScheduler.refreshNow(app)
        return Result.QUEUED
    }
}
