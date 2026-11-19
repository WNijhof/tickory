package io.github.wnijhof.tickory.store

import android.content.Context
import android.util.Log
import androidx.core.content.edit
import io.github.wnijhof.tickory.core.QueuedNote
import io.github.wnijhof.tickory.core.QuickNoteQueue
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Wat het kleine venster "Notitie toevoegen" op het toestel bewaart: de wachtrij met ingetypte notities die nog naar de server
 * moeten (`files/quicknote/queue.json`, atomair geschreven) en het concept (wat je intypte en niet toevoegde). Alles in de privé-opslag
 * van de app, niet in back-ups; het concept hoort bij één gebruiker; afmelden wist alles.
 */
object QuickNoteStore {
    private const val TAG = "TickoryQuickNote"
    private const val QUEUE = "queue.json"
    private const val PREFS = "tickory_quicknote"
    private const val KEY_TITLE = "draft_title"
    private const val KEY_CONTENT = "draft_content"
    private const val KEY_PINNED = "draft_pinned"
    private const val KEY_ACCOUNT = "draft_account"
    private val lock = Any()

    private fun dir(context: Context): File = File(context.applicationContext.filesDir, "quicknote").also { it.mkdirs() }

    private fun prefs(context: Context) = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    // ---------- de wachtrij ----------

    fun queue(context: Context): List<QueuedNote> = synchronized(lock) { QuickNoteQueue.decode(read(File(dir(context), QUEUE))) }

    /** @return false als de rij vol is (of hetzelfde uuid er al in stond), of het bewaren mislukte: dan is er niets toegevoegd */
    fun enqueue(context: Context, item: QueuedNote): Boolean = synchronized(lock) {
        val (items, added) = QuickNoteQueue.enqueue(queue(context), item)
        added && write(File(dir(context), QUEUE), QuickNoteQueue.encode(items))
    }

    /** Haalt [items] uit de wachtrij (gelukt, geweigerd of vervallen). */
    fun settle(context: Context, items: Collection<QueuedNote>) {
        if (items.isEmpty()) return
        val uuids = items.mapTo(HashSet()) { it.uuid }
        synchronized(lock) {
            val before = queue(context)
            val after = QuickNoteQueue.settle(before, uuids)
            if (after != before) write(File(dir(context), QUEUE), QuickNoteQueue.encode(after))
        }
    }

    /** Afmelden of een ander serveradres: alles weg. @return wat er nog in de wachtrij stond (daarvan komt een melding) */
    fun clearAll(context: Context): List<QueuedNote> = synchronized(lock) {
        val left = queue(context)
        File(dir(context), QUEUE).delete()
        prefs(context).edit { clear() }
        left
    }

    // ---------- het concept ----------

    data class Draft(val title: String, val content: String, val pinned: Boolean)

    /** Het concept van deze gebruiker (of van niemand in het bijzonder, als die bij het bewaren nog niet bekend was). */
    fun draft(context: Context, accountId: String?): Draft? {
        val p = prefs(context)
        val title = p.getString(KEY_TITLE, "").orEmpty()
        val content = p.getString(KEY_CONTENT, "").orEmpty()
        if (QuickNoteQueue.isEmpty(title, content)) return null
        val owner = p.getString(KEY_ACCOUNT, null)
        return if (owner == null || owner == accountId) Draft(title, content, p.getBoolean(KEY_PINNED, false)) else null
    }

    fun saveDraft(context: Context, accountId: String?, draft: Draft) = prefs(context).edit {
        if (QuickNoteQueue.isEmpty(draft.title, draft.content)) {
            clear()
        } else {
            putString(KEY_TITLE, draft.title.take(QuickNoteQueue.MAX_TITLE))
            putString(KEY_CONTENT, draft.content.take(QuickNoteQueue.MAX_CONTENT))
            putBoolean(KEY_PINNED, draft.pinned)
            if (accountId != null) putString(KEY_ACCOUNT, accountId) else remove(KEY_ACCOUNT)
        }
    }

    fun clearDraft(context: Context) = prefs(context).edit { clear() }

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
