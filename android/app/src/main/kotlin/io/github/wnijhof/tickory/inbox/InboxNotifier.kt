package io.github.wnijhof.tickory.inbox

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.InboxItem
import io.github.wnijhof.tickory.core.InboxPlan
import io.github.wnijhof.tickory.core.InboxSnapshot
import io.github.wnijhof.tickory.core.InboxState
import io.github.wnijhof.tickory.reminders.AppClock
import io.github.wnijhof.tickory.store.InboxStore

/** Staat het scherm van de app nu voor? Dan zie je nieuwe meldingen in de app zelf en komt er geen melding van het toestel bij. */
object AppVisibility {
    @Volatile
    var visible: Boolean = false
}

/**
 * Meldingen bij samenwerken als melding op het toestel (zie core/Inbox.kt voor de regels): een eigen kanaal "Samenwerken",
 * per melding één melding (het id is het label), met de knop "Openen". Een tik opent de web-app op `#notification=<id>`; die zet
 * de melding op gelezen en opent de taak of het project. Bij de volgende verversing verdwijnt een melding die gelezen is.
 */
object InboxNotifier {
    const val CHANNEL_ID = "activity"
    const val ACTION_OPEN_NOTIFICATION = "io.github.wnijhof.tickory.action.OPEN_NOTIFICATION"
    const val EXTRA_NOTIFICATION_ID = "io.github.wnijhof.tickory.extra.NOTIFICATION_ID"

    /** Een eigen nummer, naast dat van de herinneringen (1); het id van de melding is het label. */
    private const val NOTIFICATION_ID = 2
    private const val TAG = "TickoryInbox"

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.channel_activity), NotificationManager.IMPORTANCE_DEFAULT)
        channel.description = context.getString(R.string.channel_activity_description)
        manager.createNotificationChannel(channel)
    }

    /**
     * Na een verversing: nieuwe meldingen tonen en gelezen of verdwenen meldingen weghalen. Een antwoord zonder meldingen (een
     * oudere server) verandert niets.
     */
    fun apply(context: Context, snapshot: InboxSnapshot?) {
        if (snapshot == null) return
        val app = context.applicationContext
        val decision = synchronized(InboxStore.lock) {
            val d = InboxPlan.decide(InboxStore.load(app), snapshot, AppClock.now(), AppVisibility.visible)
            InboxStore.save(app, d.next)
            d
        }
        for (id in decision.cancel) cancel(app, id)
        for (item in decision.show) show(app, item)
    }

    /** Afmelden: alles weg, ook wat er nog van deze gebruiker in beeld stond. */
    fun clear(context: Context) {
        val app = context.applicationContext
        val state: InboxState? = synchronized(InboxStore.lock) { InboxStore.load(app).also { InboxStore.clear(app) } }
        for (id in state?.shown ?: emptySet()) cancel(app, id)
    }

    fun cancel(context: Context, id: String) {
        NotificationManagerCompat.from(context).cancel(id, NOTIFICATION_ID)
    }

    /** De zin bij een soort, in de taal van het toestel: "Bram heeft je een taak toegewezen". */
    fun sentence(context: Context, item: InboxItem): String {
        val actor = item.actor.ifBlank { context.getString(R.string.inbox_someone) }
        val res = when (item.kind) {
            "assigned" -> R.string.inbox_assigned
            "comment" -> if (item.taskId == null) R.string.inbox_comment_project else R.string.inbox_comment
            "mention" -> R.string.inbox_mention
            "completed" -> R.string.inbox_completed
            "shared" -> R.string.inbox_shared
            else -> R.string.inbox_other
        }
        return context.getString(res, actor)
    }

    private fun show(context: Context, item: InboxItem) {
        if (!Ids.isSafeId(item.id)) return
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return // geen toestemming: de melding staat wel in de lijst in de app
        }
        ensureChannel(context)
        val where = if (item.project != null) "${item.title} · ${item.project}" else item.title
        val body = listOfNotNull(where.takeIf { it.isNotBlank() }, item.text?.takeIf { it.isNotBlank() }).joinToString("\n")
        val open = openIntent(context, item.id)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(sentence(context, item))
            .setContentText(where)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_SOCIAL)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setWhen(item.createdAtMs)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.inbox_open), open)
        try {
            NotificationManagerCompat.from(context).notify(item.id, NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            Log.w(TAG, "melding tonen mislukt: geen toestemming") // tussen de controle en het tonen ingetrokken
        }
    }

    /** Tikken (of "Openen") opent de app bij deze melding. */
    private fun openIntent(context: Context, id: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_NOTIFICATION)
            .setData(Uri.Builder().scheme("tickory").authority("notification").appendPath(id).build())
            .putExtra(EXTRA_NOTIFICATION_ID, id)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
