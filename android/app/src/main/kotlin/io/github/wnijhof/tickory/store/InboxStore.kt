package io.github.wnijhof.tickory.store

import android.content.Context
import android.util.Log
import io.github.wnijhof.tickory.core.InboxState
import java.io.File
import java.io.IOException
import java.nio.charset.StandardCharsets
import java.nio.file.Files
import java.nio.file.StandardCopyOption

/**
 * Welke meldingen bij samenwerken dit toestel al kent en welke er in beeld staan (zie core/Inbox.kt). Eén klein bestand in de
 * privé-opslag van de app (niet in back-ups), atomair geschreven; alleen id's, geen inhoud.
 */
object InboxStore {
    private const val TAG = "TickoryInbox"
    private const val FILE = "inbox-state.json"
    val lock = Any()

    private fun file(context: Context): File = File(context.applicationContext.filesDir, FILE)

    fun load(context: Context): InboxState? = try {
        val f = file(context)
        if (f.isFile) InboxState.decode(String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8)) else null
    } catch (e: IOException) {
        Log.w(TAG, "lezen mislukt: ${e.javaClass.simpleName}")
        null
    }

    fun save(context: Context, state: InboxState) {
        try {
            val f = file(context)
            val tmp = File(f.parentFile, "$FILE.tmp")
            Files.write(tmp.toPath(), state.encode().toByteArray(StandardCharsets.UTF_8))
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } catch (e: IOException) {
            Log.w(TAG, "bewaren mislukt: ${e.javaClass.simpleName}")
        }
    }

    fun clear(context: Context) {
        file(context).delete()
    }
}
