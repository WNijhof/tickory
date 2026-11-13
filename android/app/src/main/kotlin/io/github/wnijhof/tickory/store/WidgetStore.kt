package io.github.wnijhof.tickory.store

import android.content.Context
import android.util.Log
import androidx.core.content.edit
import io.github.wnijhof.tickory.core.QueuedComplete
import io.github.wnijhof.tickory.core.WidgetCodec
import io.github.wnijhof.tickory.core.WidgetQueue
import io.github.wnijhof.tickory.core.WidgetSnapshot
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Wat de widgets op het toestel bewaren: de taken en projecten van de laatste verversing, en de wachtrij met taken die
 * in een widget zijn afgevinkt en nog bij de server moeten aankomen. Twee bestanden in de privé-opslag van de app (niet
 * in back-ups), elk atomair geschreven (eerst een tijdelijk bestand, dan hernoemen), zodat een herstart of een gestopt
 * proces nooit een half bestand achterlaat.
 *
 * De gegevens horen bij één gebruiker ([WidgetSnapshot.accountId]). Meldt een andere gebruiker zich aan, dan gaat alles weg.
 * Na een nieuwe aanmelding (ander token) staat de gebruiker nog niet vast: de gegevens zijn dan "ongecontroleerd" en
 * de widgets tonen ze niet, tot de eerste verversing laat zien van wie ze zijn.
 */
object WidgetStore {
    private const val TAG = "TickoryWidgets"
    private const val CACHE = "widget-cache.json"
    private const val QUEUE = "widget-queue.json"
    private const val UNVERIFIED = "widget-unverified"
    private val lock = Any()

    private fun dir(context: Context): File = File(context.applicationContext.filesDir, "widgets").also { it.mkdirs() }

    // ---------- de gegevens ----------

    /** De bewaarde gegevens, of null als er geen zijn of ze niet te lezen zijn. Los van of ze gecontroleerd zijn: zie [visibleSnapshot]. */
    fun snapshot(context: Context): WidgetSnapshot? = synchronized(lock) { WidgetCodec.decode(read(File(dir(context), CACHE))) }

    /** De gegevens zoals de widgets ze mogen tonen: alleen als de gebruiker vaststaat. */
    fun visibleSnapshot(context: Context): WidgetSnapshot? = synchronized(lock) { if (isUnverified(context)) null else snapshot(context) }

    /**
     * Nieuwe gegevens van de server. Zijn ze van een andere gebruiker dan de bewaarde, dan gaat de wachtrij weg: wat
     * iemand anders afvinkte, mag nooit onder dit account worden verstuurd.
     *
     * @return true als de gegevens veranderd zijn (of voor het eerst binnen zijn)
     */
    fun accept(context: Context, fresh: WidgetSnapshot): Boolean = synchronized(lock) {
        val old = snapshot(context)
        if (old != null && old.accountId != fresh.accountId) {
            write(File(dir(context), QUEUE), WidgetQueue.encode(emptyList()))
        }
        val changed = old != fresh || isUnverified(context)
        if (changed) write(File(dir(context), CACHE), WidgetCodec.encode(fresh))
        File(dir(context), UNVERIFIED).delete()
        changed
    }

    /** Er is een andere aanmelding (nieuw token): van wie de bewaarde gegevens zijn, weten we pas na de eerstvolgende verversing. */
    fun markUnverified(context: Context) = synchronized(lock) {
        if (File(dir(context), CACHE).exists() || File(dir(context), QUEUE).exists()) {
            try {
                File(dir(context), UNVERIFIED).writeText("1")
            } catch (e: IOException) {
                Log.w(TAG, "markeren mislukt: ${e.javaClass.simpleName}")
            }
        }
    }

    fun isUnverified(context: Context): Boolean = synchronized(lock) { File(dir(context), UNVERIFIED).exists() }

    /** Afmelden of een ander serveradres: alle gegevens en de wachtrij weg. */
    fun clearAll(context: Context) = synchronized(lock) {
        for (name in listOf(CACHE, QUEUE, UNVERIFIED)) File(dir(context), name).delete()
    }

    // ---------- de wachtrij ----------

    fun queue(context: Context): List<QueuedComplete> = synchronized(lock) { WidgetQueue.decode(read(File(dir(context), QUEUE))) }

    /** @return false als er voor deze taak al een afvinkactie wachtte (dubbel tikken) */
    fun enqueue(context: Context, item: QueuedComplete): Boolean = synchronized(lock) {
        val (items, added) = WidgetQueue.enqueue(queue(context), item)
        if (added) write(File(dir(context), QUEUE), WidgetQueue.encode(items))
        added
    }

    /** Past de wachtrij aan met [change] en bewaart het resultaat. */
    fun updateQueue(context: Context, change: (List<QueuedComplete>) -> List<QueuedComplete>) = synchronized(lock) {
        val before = queue(context)
        val after = change(before)
        if (after != before) write(File(dir(context), QUEUE), WidgetQueue.encode(after))
    }

    // ---------- bestanden ----------

    private fun read(file: File): String? = try {
        if (file.isFile) String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8) else null
    } catch (e: IOException) {
        Log.w(TAG, "lezen mislukt: ${e.javaClass.simpleName}")
        null
    }

    private fun write(file: File, text: String) {
        try {
            val tmp = File(file.parentFile, file.name + ".tmp")
            Files.write(tmp.toPath(), text.toByteArray(StandardCharsets.UTF_8))
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: IOException) {
            Log.w(TAG, "bewaren mislukt: ${e.javaClass.simpleName}") // geen inhoud in het logboek
        }
    }
}

/** Welke bron elke widget toont (per widget-id). Staat in de gewone instellingen van de app; bevat geen taakinhoud. */
object WidgetConfigStore {
    private const val FILE = "tickory_widget_config"

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun get(context: Context, appWidgetId: Int): String? = prefs(context).getString("w$appWidgetId", null)

    fun set(context: Context, appWidgetId: Int, sourceKey: String) {
        prefs(context).edit { putString("w$appWidgetId", sourceKey) }
    }

    fun remove(context: Context, appWidgetIds: IntArray) {
        prefs(context).edit { for (id in appWidgetIds) remove("w$id") }
    }
}
