package io.github.wnijhof.tickory.reminders

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.text.format.DateFormat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.R
import io.github.wnijhof.tickory.core.DueText
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.Lang
import io.github.wnijhof.tickory.core.PlannedReminder
import java.time.ZoneId

/** De meldingen van herinneringen: het kanaal, de melding zelf met de twee knoppen, en het weghalen. */
object Notifications {
    const val CHANNEL_ID = "reminders"

    const val ACTION_COMPLETE = "io.github.wnijhof.tickory.action.COMPLETE"
    const val ACTION_SNOOZE = "io.github.wnijhof.tickory.action.SNOOZE"
    const val ACTION_OPEN_TASK = "io.github.wnijhof.tickory.action.OPEN_TASK"

    const val EXTRA_TASK_ID = "io.github.wnijhof.tickory.extra.TASK_ID"
    private const val EXTRA_REMINDER_ID = "io.github.wnijhof.tickory.extra.REMINDER_ID"
    private const val EXTRA_TITLE = "io.github.wnijhof.tickory.extra.TITLE"
    private const val EXTRA_TASK_DUE = "io.github.wnijhof.tickory.extra.TASK_DUE"
    private const val EXTRA_TRIGGER_AT = "io.github.wnijhof.tickory.extra.TRIGGER_AT"

    /** Alle meldingen delen dit nummer; de herinnering-id is het label waarmee Android ze uit elkaar houdt. */
    private const val NOTIFICATION_ID = 1

    /**
     * Maakt het kanaal "Herinneringen", of werkt de naam bij als de taal van het toestel is veranderd. Hoge
     * prioriteit: de melding komt in beeld en maakt geluid. Het geluid is het standaardgeluid van het toestel en
     * trillen staat aan met het standaardpatroon; of het toestel dan echt geluid maakt of trilt, volgt de instellingen
     * van Android (stil, trillen, niet storen). De gebruiker kan het per kanaal aanpassen in de instellingen van Android.
     */
    fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val channel = NotificationChannel(CHANNEL_ID, context.getString(R.string.channel_reminders), NotificationManager.IMPORTANCE_HIGH)
        channel.description = context.getString(R.string.channel_reminders_description)
        channel.enableVibration(true)
        manager.createNotificationChannel(channel)
    }

    /** Mag de app nu meldingen tonen? (De toestemming op Android 13 en nieuwer, en het kanaal niet uitgezet.) */
    fun enabled(context: Context): Boolean {
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) return false
        val channel = context.getSystemService(NotificationManager::class.java)?.getNotificationChannel(CHANNEL_ID)
        return channel == null || channel.importance != NotificationManager.IMPORTANCE_NONE
    }

    /**
     * Toont de herinnering, of vervangt de melding die er al staat.
     *
     * @param note in plaats van "Herinnering · vandaag 14:00" deze tekst tonen (bijvoorbeeld waarom voltooien niet lukte)
     * @param actions welke knoppen de melding krijgt
     * @param quiet zonder geluid: voor het bijwerken van een melding die er al stond
     */
    fun show(context: Context, reminder: PlannedReminder, note: String? = null, actions: Actions = Actions.BOTH, quiet: Boolean = false) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return // geen toestemming: Android zou de melding toch weggooien
        }
        ensureChannel(context)

        val title = reminder.title.ifBlank { context.getString(R.string.task_untitled) }
        val text = note ?: defaultText(context, reminder)
        val builder = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_reminder)
            .setColor(ContextCompat.getColor(context, R.color.notification_accent))
            .setContentTitle(title)
            .setContentText(text)
            // uitgeklapt: de hele titel als die lang is, en de hele toelichting
            .setStyle(NotificationCompat.BigTextStyle().bigText(if (title.length > 40) "$title\n$text" else text))
            .setCategory(NotificationCompat.CATEGORY_REMINDER)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setWhen(reminder.triggerAtMs)
            .setShowWhen(true)
            .setAutoCancel(true)
            .setOnlyAlertOnce(quiet)
            .setSilent(quiet)
            .setContentIntent(openTaskIntent(context, reminder.taskId))
            .addExtras(Bundle().apply { putString(EXTRA_TASK_ID, reminder.taskId) })

        if (actions == Actions.BOTH) {
            builder.addAction(0, context.getString(R.string.action_complete), actionIntent(context, ACTION_COMPLETE, reminder))
        }
        if (actions != Actions.NONE) {
            builder.addAction(0, context.getString(R.string.action_snooze), actionIntent(context, ACTION_SNOOZE, reminder))
        }

        try {
            NotificationManagerCompat.from(context).notify(reminder.reminderId, NOTIFICATION_ID, builder.build())
        } catch (_: SecurityException) {
            // de toestemming is tussen de controle en het tonen ingetrokken
        }
    }

    enum class Actions { BOTH, SNOOZE_ONLY, NONE }

    fun cancel(context: Context, reminderId: String) {
        NotificationManagerCompat.from(context).cancel(reminderId, NOTIFICATION_ID)
    }

    /** Haalt de meldingen weg van taken waarvoor [keep] false geeft (afgevinkt of verwijderd, hier of op een ander toestel). */
    fun cancelWhere(context: Context, keep: (taskId: String) -> Boolean) {
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        val active = try {
            manager.activeNotifications
        } catch (_: RuntimeException) {
            return
        }
        for (shown in active) {
            if (shown.id != NOTIFICATION_ID || shown.tag == null) continue
            val taskId = shown.notification.extras?.getString(EXTRA_TASK_ID) ?: continue
            if (!keep(taskId)) manager.cancel(shown.tag, NOTIFICATION_ID)
        }
    }

    fun cancelAll(context: Context) {
        NotificationManagerCompat.from(context).cancelAll()
    }

    /** De herinnering waar een knop van de melding bij hoort, of null als de gegevens niet kloppen. */
    fun reminderFrom(intent: Intent): PlannedReminder? {
        val reminderId = intent.getStringExtra(EXTRA_REMINDER_ID)?.takeIf(Ids::isSafeId) ?: return null
        val taskId = intent.getStringExtra(EXTRA_TASK_ID)?.takeIf(Ids::isSafeId) ?: return null
        val at = intent.getLongExtra(EXTRA_TRIGGER_AT, -1L).takeIf { it >= 0 } ?: return null
        return PlannedReminder(reminderId, taskId, intent.getStringExtra(EXTRA_TITLE) ?: "", at, intent.getStringExtra(EXTRA_TASK_DUE))
    }

    /** "Herinnering · vandaag 14:00", of alleen "Herinnering" als de taak geen datum heeft. */
    private fun defaultText(context: Context, reminder: PlannedReminder): String {
        val lang = Lang.of(context.getString(R.string.language_code))
        val due = DueText.format(reminder.taskDue, AppClock.now(), ZoneId.systemDefault(), lang, DateFormat.is24HourFormat(context))
        return if (due != null) context.getString(R.string.notification_reminder_due, due) else context.getString(R.string.notification_reminder)
    }

    /** Tikken op de melding opent de app bij de taak. */
    private fun openTaskIntent(context: Context, taskId: String): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(ACTION_OPEN_TASK)
            .setData(Uri.Builder().scheme("tickory").authority("task").appendPath(taskId).build())
            .putExtra(EXTRA_TASK_ID, taskId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    /** De knoppen gaan naar een ontvanger in de app zelf (geen scherm): voltooien en uitstellen gebeuren op de achtergrond. */
    private fun actionIntent(context: Context, action: String, reminder: PlannedReminder): PendingIntent {
        val intent = Intent(context, ActionReceiver::class.java)
            .setAction(action)
            .setData(Uri.Builder().scheme("tickory").authority("action").appendPath(reminder.reminderId).build())
            .putExtra(EXTRA_REMINDER_ID, reminder.reminderId)
            .putExtra(EXTRA_TASK_ID, reminder.taskId)
            .putExtra(EXTRA_TITLE, reminder.title)
            .putExtra(EXTRA_TASK_DUE, reminder.taskDue)
            .putExtra(EXTRA_TRIGGER_AT, reminder.triggerAtMs)
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }
}
