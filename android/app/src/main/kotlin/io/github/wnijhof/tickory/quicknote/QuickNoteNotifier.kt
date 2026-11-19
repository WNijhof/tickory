package io.github.wnijhof.tickory.quicknote

import android.content.Context
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.QueuedNote
import io.github.wnijhof.tickory.quickadd.QuickAddNotifier
import io.github.wnijhof.tickory.store.QuickNoteStore

/**
 * Een notitie uit het kleine venster die niet bij de server aankwam, als melding met de tekst: zo gaat er niets stil verloren. Zelfde
 * kanaal en uitleg als bij een taak (QuickAddNotifier). De tekst komt bovendien terug als concept in het venster (als daar niet al een
 * ander concept staat), dus ook zonder toestemming voor meldingen is hij niet kwijt. Na afmelden of bij een ander account niet: dan
 * hoort er niets van het vorige account op het toestel te blijven.
 */
object QuickNoteNotifier {
    private const val TAG = "TickoryQuickNote"

    fun notDelivered(context: Context, item: QueuedNote, reason: QuickAddNotifier.Reason, code: String? = null) {
        val keep = reason != QuickAddNotifier.Reason.SIGNED_OUT && reason != QuickAddNotifier.Reason.OTHER_ACCOUNT
        if (keep && QuickNoteStore.draft(context, item.accountId) == null) {
            QuickNoteStore.saveDraft(context, item.accountId, QuickNoteStore.Draft(item.title, item.content, item.pinned))
        }
        if (!QuickAddNotifier.canNotify(context)) {
            Log.w(TAG, "melding niet getoond: meldingen staan uit") // geen tekst in het logboek
            return
        }
        QuickAddNotifier.ensureChannel(context)
        val why = QuickAddNotifier.explanation(context, reason, code)
        val name = (item.title.ifBlank { item.content }).replace(Regex("\\s+"), " ").trim().take(60)
        val open = android.app.PendingIntent.getActivity(
            context, 0, QuickNoteActivity.launchIntent(context), android.app.PendingIntent.FLAG_UPDATE_CURRENT or android.app.PendingIntent.FLAG_IMMUTABLE,
        )
        val builder = NotificationCompat.Builder(context, QuickAddNotifier.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(context.getString(R.string.quick_note_failed_title, name))
            .setContentText(why)
            .setStyle(NotificationCompat.BigTextStyle().bigText("${item.content.trim().take(400)}\n\n$why"))
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(open)
        try {
            NotificationManagerCompat.from(context).notify(item.uuid, QuickAddNotifier.NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            Log.w(TAG, "melding tonen mislukt: geen toestemming")
        }
    }
}
