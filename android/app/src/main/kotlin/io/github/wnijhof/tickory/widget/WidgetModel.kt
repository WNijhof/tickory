package io.github.wnijhof.tickory.widget

import android.content.Context
import android.text.format.DateFormat
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.Lang
import io.github.wnijhof.tickory.core.WidgetContent
import io.github.wnijhof.tickory.core.WidgetContentBuilder
import io.github.wnijhof.tickory.core.WidgetSnapshot
import io.github.wnijhof.tickory.core.WidgetQueue
import io.github.wnijhof.tickory.core.WidgetSource
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.Prefs
import io.github.wnijhof.tickory.store.WidgetStore
import io.github.wnijhof.tickory.sync.Session
import java.time.ZoneId

/**
 * Wat een widget nu moet laten zien. Leest alleen de gegevens op het toestel (nooit het netwerk of een WebView), en
 * nooit meer dan de aangemelde gebruiker mag zien: zonder aanmelding, met een verlopen aanmelding of zolang niet vaststaat
 * van wie de bewaarde gegevens zijn (na een nieuwe aanmelding), toont de widget geen enkele taak.
 */
object WidgetModel {
    sealed class State {
        /** Geen server of geen aanmelding: "Log in in de app". */
        object SignedOut : State()

        /** De server zegt dat de aanmelding niet meer geldt: "Log opnieuw in in de app". */
        object Expired : State()

        /** Aangemeld, maar de eerste gegevens zijn er nog niet (of nog niet gecontroleerd). */
        object Loading : State()

        data class Ready(val content: WidgetContent, val snapshot: WidgetSnapshot) : State()
    }

    fun state(context: Context, source: WidgetSource, nowMs: Long = AppClock.now()): State {
        val app = context.applicationContext
        val prefs = Prefs(app)
        if (prefs.serverOrigin == null || prefs.encryptedToken == null) return State.SignedOut
        if (prefs.sessionExpired) return State.Expired
        if (!Session.isActive(app)) return State.SignedOut
        val snapshot = WidgetStore.visibleSnapshot(app) ?: return State.Loading
        val hidden = WidgetQueue.forAccount(WidgetStore.queue(app), snapshot.accountId).mapTo(HashSet()) { it.taskId }
        val content = WidgetContentBuilder.build(snapshot, source, hidden, nowMs, ZoneId.systemDefault(), lang(app), DateFormat.is24HourFormat(app))
        return State.Ready(content, snapshot)
    }

    fun lang(context: Context): Lang = Lang.of(context.getString(R.string.language_code))

    /** De titel van een lijst, ook als er nog geen gegevens zijn. */
    fun title(context: Context, source: WidgetSource, content: WidgetContent?): String = when (source) {
        WidgetSource.Today -> context.getString(R.string.widget_title_today)
        WidgetSource.Upcoming -> context.getString(R.string.widget_title_upcoming)
        WidgetSource.Inbox -> content?.projectName ?: context.getString(R.string.widget_title_inbox)
        is WidgetSource.Project -> content?.projectName ?: context.getString(R.string.widget_title_project_fallback)
        is WidgetSource.Filter -> context.getString(R.string.widget_title_project_fallback)
    }

    /** Waar "+" in de widget een taak laat toevoegen: Vandaag met vandaag als datum, een project in dat project. */
    fun addTarget(source: WidgetSource, snapshot: WidgetSnapshot?): String? = when (source) {
        WidgetSource.Today -> "today"
        WidgetSource.Upcoming -> null
        WidgetSource.Inbox -> snapshot?.inboxId
        is WidgetSource.Project -> if (snapshot?.project(source.id) != null) source.id else null
        is WidgetSource.Filter -> null
    }
}
