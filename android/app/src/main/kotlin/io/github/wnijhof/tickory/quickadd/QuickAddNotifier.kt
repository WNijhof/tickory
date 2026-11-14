package io.github.wnijhof.tickory.quickadd

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
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.core.QueuedQuickAdd
import io.github.wnijhof.tickory.core.QuickAddQueue
import io.github.wnijhof.tickory.store.QuickAddStore
import java.time.DateTimeException
import java.time.OffsetDateTime
import java.time.ZoneId

/**
 * Een taak uit het kleine venster die niet bij de server aankwam, als melding met de tekst: zo gaat er niets stil verloren. Een
 * eigen kanaal "Taken toevoegen" (gewone prioriteit). Een tik (of "In de app toevoegen") opent de app met de tekst in het venster
 * Taak toevoegen, in het gekozen project en op de gekozen dag; daar kun je hem aanpassen of in een ander project zetten.
 */
object QuickAddNotifier {
    const val CHANNEL_ID = "quickadd"

    /** Een eigen nummer, naast herinneringen (1) en samenwerken (2); het uuid van de taak is het label. */
    const val NOTIFICATION_ID = 3
    private const val TAG = "TickoryQuickAdd"

    enum class Reason { FORBIDDEN, NOT_FOUND, LIMIT, INVALID, UNSUPPORTED, EXPIRED, SIGNED_OUT, OTHER_ACCOUNT, OTHER }

    /** Welke uitleg bij een foutcode van de server hoort. */
    fun reasonFor(code: String): Reason = when (code) {
        "FORBIDDEN" -> Reason.FORBIDDEN
        "NOT_FOUND" -> Reason.NOT_FOUND
        "LIMIT_REACHED" -> Reason.LIMIT
        "INVALID_ARG", "MISSING_ARG", "UNKNOWN_ARG", "CONFLICT", "DUPLICATE" -> Reason.INVALID
        else -> Reason.OTHER
    }

    fun explanation(context: Context, reason: Reason, code: String?): String = when (reason) {
        Reason.FORBIDDEN -> context.getString(R.string.quick_failed_forbidden)
        Reason.NOT_FOUND -> context.getString(R.string.quick_failed_not_found)
        Reason.LIMIT -> context.getString(R.string.quick_failed_limit)
        Reason.INVALID -> context.getString(R.string.quick_failed_invalid)
        Reason.UNSUPPORTED -> context.getString(R.string.quick_failed_unsupported)
        Reason.EXPIRED -> context.getString(R.string.quick_failed_expired)
        Reason.SIGNED_OUT -> context.getString(R.string.quick_failed_signed_out)
        Reason.OTHER_ACCOUNT -> context.getString(R.string.quick_failed_other_account)
        Reason.OTHER -> context.getString(R.string.quick_failed_other, code ?: "?")
    }

    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.channel_quickadd), NotificationManager.IMPORTANCE_DEFAULT)
        channel.description = context.getString(R.string.channel_quickadd_description)
        manager.createNotificationChannel(channel)
    }

    /** Kan de app nu een melding in dit kanaal tonen? (De toestemming op Android 13 en nieuwer, meldingen aan, het kanaal niet uit.) */
    fun canNotify(context: Context): Boolean {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return false
        }
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val channel = context.getSystemService(NotificationManager::class.java)?.getNotificationChannel(CHANNEL_ID)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    /**
     * Eén melding per taak die niet aankwam. Mag de app geen meldingen tonen, dan komt de tekst (bij een weigering, een oudere
     * server of na veertien dagen) terug in het kleine venster, de volgende keer dat je het opent, met de reden erbij. Na afmelden of
     * bij een ander account niet: dan hoort er niets van het vorige account op het toestel te blijven.
     */
    fun notDelivered(context: Context, item: QueuedQuickAdd, reason: Reason, code: String? = null) {
        val why = explanation(context, reason, code)
        if (!canNotify(context)) {
            Log.w(TAG, "melding niet getoond: meldingen staan uit") // geen tekst in het logboek
            if (reason != Reason.SIGNED_OUT && reason != Reason.OTHER_ACCOUNT) QuickAddStore.keepReturned(context, item, why)
            return
        }
        ensureChannel(context)
        val title = context.getString(R.string.quick_failed_title, item.text.replace(Regex("\\s+"), " ").trim())
        val open = openIntent(context, item)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(title)
            .setContentText(why)
            .setStyle(NotificationCompat.BigTextStyle().bigText("${item.text.trim()}\n\n$why"))
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setAutoCancel(true)
            .setContentIntent(open)
            .addAction(0, context.getString(R.string.quick_failed_action), open)
        try {
            NotificationManagerCompat.from(context).notify(item.uuid, NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            Log.w(TAG, "melding tonen mislukt: geen toestemming")
        }
    }

    /** De app openen met de tekst in Taak toevoegen. Expliciet, onveranderlijk, en per taak een eigen adres. */
    fun openIntent(context: Context, item: QueuedQuickAdd): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setData(Uri.Builder().scheme("tickory").authority("quickadd").appendPath(item.uuid).build())
            .putExtra(DeepLink.EXTRA_DRAFT_TEXT, QuickAddQueue.textForApp(item.text, item.priority))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        if (item.projectId != null) intent.putExtra(DeepLink.EXTRA_DRAFT_PROJECT, item.projectId)
        dayOf(item)?.let { intent.putExtra(DeepLink.EXTRA_DRAFT_DUE, it) }
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** De dag van de knop Vandaag of Morgen, zoals die bij het intypen bedoeld was ('YYYY-MM-DD'). */
    fun dayOf(item: QueuedQuickAdd): String? {
        if (item.due == null) return null
        val typed = try {
            OffsetDateTime.parse(item.typedAt).atZoneSameInstant(ZoneId.of(item.tz)).toLocalDate()
        } catch (_: DateTimeException) {
            return null // een kapotte tijd of een onbekende tijdzone: dan zonder dag
        }
        return (if (item.due == QuickAddQueue.DUE_TOMORROW) typed.plusDays(1) else typed).toString()
    }

    fun cancel(context: Context, uuid: String) {
        NotificationManagerCompat.from(context).cancel(uuid, NOTIFICATION_ID)
    }
}
