package io.github.wnijhof.tickory.reminders

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.util.Log

/**
 * Zet en wist de alarmen van Android: één per herinnering (en één per uitgestelde melding).
 *
 * Keuze: setExactAndAllowWhileIdle en niet setAlarmClock. Beide gaan op de minuut af, ook als het toestel in de
 * diepe slaapstand (Doze) staat. setAlarmClock zet daarbij het wekkericoontje in de statusbalk en vervangt "volgende
 * wekker" op het vergrendelscherm door onze herinnering; voor iemand met tien herinneringen per dag is dat storend en
 * het verdringt de echte wekker. De prijs van onze keuze: Android begrenst hoe vaak zulke alarmen in de slaapstand
 * door mogen (op oudere versies ongeveer één per negen minuten per app), dus een tweede herinnering vlak na de eerste
 * kan dan enkele minuten later komen.
 *
 * Mag de app geen exacte alarmen zetten (Android 12 en 12L, als de gebruiker dat heeft uitgezet), dan vallen we terug
 * op setAndAllowWhileIdle: dat gaat ook in de slaapstand af, maar Android mag het dan wat later bezorgen.
 */
object AlarmScheduler {
    private const val TAG = "TickoryAlarm"

    enum class Kind(val path: String) { REMINDER("reminder"), SNOOZE("snooze") }

    const val ACTION_ALARM = "io.github.wnijhof.tickory.action.ALARM"

    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        val manager = context.getSystemService(AlarmManager::class.java) ?: return false
        return manager.canScheduleExactAlarms()
    }

    fun set(context: Context, kind: Kind, reminderId: String, atMs: Long) {
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = pendingIntent(context, kind, reminderId, PendingIntent.FLAG_UPDATE_CURRENT) ?: return
        try {
            if (canScheduleExact(context)) {
                manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, intent)
            } else {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, intent)
            }
        } catch (e: SecurityException) {
            // de toestemming is net ingetrokken: dan maar bij benadering
            Log.w(TAG, "exact alarm geweigerd, bij benadering gezet")
            try {
                manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, intent)
            } catch (e2: RuntimeException) {
                Log.w(TAG, "alarm zetten mislukt: ${e2.javaClass.simpleName}")
            }
        } catch (e: RuntimeException) {
            // bijvoorbeeld het maximum van 500 alarmen per app; wij blijven daar met 200 ruim onder
            Log.w(TAG, "alarm zetten mislukt: ${e.javaClass.simpleName}")
        }
    }

    fun cancel(context: Context, kind: Kind, reminderId: String) {
        val manager = context.getSystemService(AlarmManager::class.java) ?: return
        val intent = pendingIntent(context, kind, reminderId, PendingIntent.FLAG_NO_CREATE) ?: return
        manager.cancel(intent)
        intent.cancel()
    }

    /**
     * Elk alarm heeft een eigen adres ("tickory://alarm/reminder/<id>"): Android onderscheidt alarmen op actie en
     * adres, niet op de extra gegevens. Het alarm draagt bewust geen gegevens over de taak: als het afgaat, kijkt de
     * app in zijn eigen opslag wat er getoond moet worden.
     */
    private fun pendingIntent(context: Context, kind: Kind, reminderId: String, flag: Int): PendingIntent? {
        val intent = Intent(context, AlarmReceiver::class.java)
            .setAction(ACTION_ALARM)
            .setData(Uri.Builder().scheme("tickory").authority("alarm").appendPath(kind.path).appendPath(reminderId).build())
        return PendingIntent.getBroadcast(context, 0, intent, flag or PendingIntent.FLAG_IMMUTABLE)
    }
}
