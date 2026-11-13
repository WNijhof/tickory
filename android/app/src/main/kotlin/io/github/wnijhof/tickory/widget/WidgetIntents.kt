package io.github.wnijhof.tickory.widget

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import io.github.wnijhof.tickory.MainActivity
import io.github.wnijhof.tickory.core.DeepLink
import io.github.wnijhof.tickory.reminders.Notifications

/**
 * De intenties van de widgets. Allemaal expliciet (met de naam van een scherm of ontvanger van de app zelf) en
 * onveranderlijk (FLAG_IMMUTABLE), op één na: de lijst van taken kan alleen werken met een sjabloon dat per regel
 * wordt aangevuld ("fill-in") met de taak waarop getikt is, en dat vraagt FLAG_MUTABLE. Dat sjabloon wijst vast naar
 * [WidgetActionActivity], die niet door andere apps aan te roepen is (exported="false") en elk id controleert.
 */
object WidgetIntents {
    const val EXTRA_KIND = "io.github.wnijhof.tickory.extra.WIDGET_KIND"
    const val KIND_COMPLETE = "complete"
    const val KIND_OPEN = "open"

    private val IMMUTABLE = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE

    /** Tikken op de kop: de app openen. */
    fun openApp(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setAction(Intent.ACTION_MAIN)
            .addCategory(Intent.CATEGORY_LAUNCHER)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, REQUEST_OPEN_APP, intent, IMMUTABLE)
    }

    /** De knop "+": de app openen op het venster Taak toevoegen ([target]: zie DeepLink.add). */
    fun addTask(context: Context, target: String?): PendingIntent {
        val intent = Intent(context, MainActivity::class.java)
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("add").appendPath(target ?: "-").build())
            .putExtra(DeepLink.EXTRA_ADD, target ?: "")
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
        return PendingIntent.getActivity(context, REQUEST_ADD, intent, IMMUTABLE)
    }

    /** Het sjabloon voor de regels van de lijst van widget [appWidgetId]; elke regel vult het aan met [fillIn]. */
    fun itemTemplate(context: Context, appWidgetId: Int): PendingIntent {
        val intent = Intent(context, WidgetActionActivity::class.java)
            .setData(Uri.Builder().scheme("tickory").authority("widget").appendPath("item").appendPath(appWidgetId.toString()).build())
        val flags = PendingIntent.FLAG_UPDATE_CURRENT or if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
        return PendingIntent.getActivity(context, appWidgetId, intent, flags)
    }

    /** Wat een regel aan het sjabloon toevoegt: wat er moet gebeuren ([KIND_COMPLETE] of [KIND_OPEN]) en voor welke taak. */
    fun fillIn(kind: String, taskId: String): Intent = Intent().putExtra(EXTRA_KIND, kind).putExtra(Notifications.EXTRA_TASK_ID, taskId)

    /** Een taak openen in de app. */
    fun openTask(context: Context, taskId: String): Intent =
        Intent(context, MainActivity::class.java)
            .setData(Uri.Builder().scheme("tickory").authority("task").appendPath(taskId).build())
            .putExtra(Notifications.EXTRA_TASK_ID, taskId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)

    private const val REQUEST_OPEN_APP = 1
    private const val REQUEST_ADD = 2
}
