package io.github.wnijhof.tickory.store

import android.content.Context
import android.util.Log
import androidx.core.content.edit
import io.github.wnijhof.tickory.core.Ids
import io.github.wnijhof.tickory.core.Json
import io.github.wnijhof.tickory.core.QueuedQuickAdd
import io.github.wnijhof.tickory.core.QuickAddQueue
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Wat het kleine venster "Taak toevoegen" op het toestel bewaart:
 *  - de wachtrij met ingetypte taken die nog naar de server moeten (`files/quickadd/queue.json`, atomair geschreven, zodat een
 *    herstart of een gestopt proces nooit een half bestand achterlaat);
 *  - het concept: tekst die je intypte en niet toevoegde (terug of ernaast getikt), tot de volgende keer;
 *  - het laatst gekozen project;
 *  - taken die niet aankwamen terwijl de app geen meldingen mocht tonen: die komen terug in het venster.
 * Alles in de privé-opslag van de app, niet in back-ups. Het concept en het project horen bij één gebruiker; afmelden wist alles.
 */
object QuickAddStore {
    private const val TAG = "TickoryQuickAdd"
    private const val QUEUE = "queue.json"
    private const val PREFS = "tickory_quickadd"
    private const val KEY_DRAFT = "draft"
    private const val KEY_DRAFT_ACCOUNT = "draft_account"
    private const val KEY_PROJECT = "last_project"
    private const val KEY_PROJECT_ACCOUNT = "last_project_account"
    private const val KEY_RETURNED = "returned"
    private const val MAX_RETURNED = 20
    private val lock = Any()

    private fun dir(context: Context): File = File(context.applicationContext.filesDir, "quickadd").also { it.mkdirs() }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---------- de wachtrij ----------

    fun queue(context: Context): List<QueuedQuickAdd> = synchronized(lock) { QuickAddQueue.decode(read(File(dir(context), QUEUE))) }

    /** @return false als de rij vol is (of hetzelfde uuid er al in stond), of het bewaren mislukte: dan is er niets toegevoegd */
    fun enqueue(context: Context, item: QueuedQuickAdd): Boolean = synchronized(lock) {
        val (items, added) = QuickAddQueue.enqueue(queue(context), item)
        added && write(File(dir(context), QUEUE), QuickAddQueue.encode(items))
    }

    /** Meer taken tegelijk (een geplakte lijst): allemaal of geen. */
    fun enqueueAll(context: Context, items: List<QueuedQuickAdd>): Boolean = synchronized(lock) {
        val (all, added) = QuickAddQueue.enqueueAll(queue(context), items)
        added && write(File(dir(context), QUEUE), QuickAddQueue.encode(all))
    }

    /** Past de wachtrij aan met [change] en bewaart het resultaat. */
    fun updateQueue(context: Context, change: (List<QueuedQuickAdd>) -> List<QueuedQuickAdd>) = synchronized(lock) {
        val before = queue(context)
        val after = change(before)
        if (after != before) write(File(dir(context), QUEUE), QuickAddQueue.encode(after))
    }

    /** Haalt [items] uit de wachtrij (gelukt, geweigerd of vervallen). */
    fun settle(context: Context, items: Collection<QueuedQuickAdd>) {
        if (items.isEmpty()) return
        val uuids = items.mapTo(HashSet()) { it.uuid }
        updateQueue(context) { QuickAddQueue.settle(it, uuids) }
    }

    /** Afmelden of een ander serveradres: alles weg. @return wat er nog in de wachtrij stond (daarvan komt een melding) */
    fun clearAll(context: Context): List<QueuedQuickAdd> = synchronized(lock) {
        val left = queue(context)
        File(dir(context), QUEUE).delete()
        prefs(context).edit { clear() }
        left
    }

    // ---------- concept en laatst gekozen project ----------

    /** Het concept van deze gebruiker (of van niemand in het bijzonder, als die bij het bewaren nog niet bekend was). */
    fun draft(context: Context, accountId: String?): String? {
        val p = prefs(context)
        val text = p.getString(KEY_DRAFT, null)?.takeIf { it.isNotBlank() } ?: return null
        val owner = p.getString(KEY_DRAFT_ACCOUNT, null)
        return if (owner == null || owner == accountId) text else null
    }

    fun saveDraft(context: Context, accountId: String?, text: String) = prefs(context).edit {
        val t = text.take(QuickAddQueue.MAX_TEXT)
        if (t.isBlank()) {
            remove(KEY_DRAFT)
            remove(KEY_DRAFT_ACCOUNT)
        } else {
            putString(KEY_DRAFT, t)
            if (accountId != null) putString(KEY_DRAFT_ACCOUNT, accountId) else remove(KEY_DRAFT_ACCOUNT)
        }
    }

    fun clearDraft(context: Context) = prefs(context).edit {
        remove(KEY_DRAFT)
        remove(KEY_DRAFT_ACCOUNT)
    }

    /** Een taak die niet aankwam en terug moet in het venster (als er geen melding kon komen): de tekst, het project en waarom. */
    data class Returned(val text: String, val projectId: String?, val why: String)

    /** Bewaart een taak die niet aankwam, voor de volgende keer dat het venster opent (hooguit [MAX_RETURNED], de oudste eerst). */
    fun keepReturned(context: Context, item: QueuedQuickAdd, why: String) = synchronized(lock) {
        val list = returnedList(context)
        list.add(mapOf("text" to item.text, "project" to item.projectId, "why" to why, "account" to item.accountId))
        while (list.size > MAX_RETURNED) list.removeAt(0)
        prefs(context).edit { putString(KEY_RETURNED, Json.stringify(list)) }
    }

    /** De oudste taak die terug moet, van deze gebruiker (of van niemand in het bijzonder); hij gaat daarmee uit de lijst. */
    fun takeReturned(context: Context, accountId: String?): Returned? = synchronized(lock) {
        val list = returnedList(context)
        val index = list.indexOfFirst { val owner = it["account"] as? String; owner == null || owner == accountId }
        if (index < 0) return null
        val entry = list.removeAt(index)
        prefs(context).edit { putString(KEY_RETURNED, Json.stringify(list)) }
        val text = (entry["text"] as? String)?.takeIf { it.isNotBlank() } ?: return null
        Returned(text, (entry["project"] as? String)?.takeIf(Ids::isSafeId), entry["why"] as? String ?: "")
    }

    private fun returnedList(context: Context): MutableList<Map<String, Any?>> =
        (Json.asList(Json.parseObject("{\"l\":${prefs(context).getString(KEY_RETURNED, null) ?: "[]"}}")?.get("l")) ?: emptyList())
            .mapNotNullTo(ArrayList()) { Json.asObject(it) }

    fun lastProject(context: Context, accountId: String?): String? {
        val p = prefs(context)
        if (accountId == null || p.getString(KEY_PROJECT_ACCOUNT, null) != accountId) return null
        return p.getString(KEY_PROJECT, null)?.takeIf(Ids::isSafeId)
    }

    /** @param projectId null voor de Inbox */
    fun setLastProject(context: Context, accountId: String?, projectId: String?) = prefs(context).edit {
        if (accountId == null || projectId == null) {
            remove(KEY_PROJECT)
            remove(KEY_PROJECT_ACCOUNT)
        } else {
            putString(KEY_PROJECT, projectId)
            putString(KEY_PROJECT_ACCOUNT, accountId)
        }
    }

    // ---------- bestanden ----------

    private fun read(file: File): String? = try {
        if (file.isFile) String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8) else null
    } catch (e: IOException) {
        Log.w(TAG, "lezen mislukt: ${e.javaClass.simpleName}")
        null
    }

    private fun write(file: File, text: String): Boolean = try {
        val tmp = File(file.parentFile, file.name + ".tmp")
        Files.write(tmp.toPath(), text.toByteArray(StandardCharsets.UTF_8))
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        true
    } catch (e: IOException) {
        Log.w(TAG, "bewaren mislukt: ${e.javaClass.simpleName}") // geen inhoud in het logboek
        false
    }
}
