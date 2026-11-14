package io.github.wnijhof.tickory.store

import android.content.Context
import android.net.Uri
import android.provider.OpenableColumns
import io.github.wnijhof.tickory.core.AttachmentName
import io.github.wnijhof.tickory.core.ShareLink
import java.io.File
import java.io.IOException
import java.security.SecureRandom
import java.util.Base64

/**
 * Bestanden die een andere app naar Tickory deelt ("Delen naar Tickory"). De inhoud wordt eenmalig naar de cache van de app
 * gekopieerd (de rechten op het origineel zijn tijdelijk) onder een willekeurig token; de web-app haalt elk bestand daarna op
 * via `/__tickory_share/<token>/<nummer>`, dat de WebView uit dit bestand beantwoordt (zie MainActivity). Zo hoeft er niets via
 * de brug of base64 en kan een bestand van tientallen megabytes gewoon als `File` in de pagina komen. Een token is 128 bits
 * willekeurig, geldt tien minuten en alleen voor de pagina van de eigen server; bij het opstarten wordt alles gewist.
 */
object ShareStore {
    const val PATH_PREFIX = "/__tickory_share/"
    const val TTL_MS = 10 * 60 * 1000L
    const val MAX_FILE_BYTES = 200L * 1024 * 1024
    const val MAX_TOTAL_BYTES = 400L * 1024 * 1024
    private const val DIR = "share"

    class Item(val file: File, val name: String, val mime: String, val size: Long)
    private class Entry(val items: List<Item>, val expiresAt: Long)

    private val entries = HashMap<String, Entry>()
    private val random = SecureRandom()

    private fun root(context: Context) = File(context.cacheDir, DIR)

    private fun newToken(): String {
        val bytes = ByteArray(16)
        random.nextBytes(bytes)
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)
    }

    /**
     * Kopieert de gedeelde bestanden naar de cache. Duurt even bij grote bestanden: niet op de hoofddraad aanroepen. Geeft het
     * token en de bestanden terug, of null als er niets te kopiëren viel. Een bestand dat niet te lezen of te groot is, wordt overgeslagen.
     */
    fun import(context: Context, uris: List<Uri>, now: Long = System.currentTimeMillis()): Pair<String, List<ShareLink.SharedFile>>? {
        val token = newToken()
        val dir = File(root(context), token)
        val items = ArrayList<Item>()
        var total = 0L
        for (uri in uris.take(ShareLink.MAX_FILES)) {
            if (total >= MAX_TOTAL_BYTES) break
            val target = File(dir, items.size.toString())
            val copied = copy(context, uri, target, MAX_FILE_BYTES.coerceAtMost(MAX_TOTAL_BYTES - total)) ?: continue
            val mime = AttachmentName.mime(
                try {
                    context.contentResolver.getType(uri)
                } catch (e: RuntimeException) {
                    null
                },
            )
            items.add(Item(target, nameOf(context, uri), mime, copied))
            total += copied
        }
        if (items.isEmpty()) {
            dir.deleteRecursively()
            return null
        }
        synchronized(entries) {
            expire(context, now)
            entries[token] = Entry(items, now + TTL_MS)
        }
        return token to items.map { ShareLink.SharedFile(it.name, it.mime, it.size) }
    }

    private fun copy(context: Context, uri: Uri, target: File, max: Long): Long? {
        return try {
            target.parentFile?.mkdirs()
            val input = context.contentResolver.openInputStream(uri) ?: return null
            var total = 0L
            input.use { source ->
                target.outputStream().use { out ->
                    val buffer = ByteArray(32 * 1024)
                    while (true) {
                        val n = source.read(buffer)
                        if (n < 0) break
                        total += n
                        if (total > max) {
                            target.delete()
                            return null
                        }
                        out.write(buffer, 0, n)
                    }
                }
            }
            if (total == 0L) {
                target.delete()
                null
            } else {
                total
            }
        } catch (e: IOException) {
            target.delete()
            null
        } catch (e: RuntimeException) {
            // geen rechten meer op het origineel, of geen geldig adres: dit bestand overslaan
            target.delete()
            null
        }
    }

    /** De naam die de andere app opgeeft, schoongemaakt. */
    private fun nameOf(context: Context, uri: Uri): String {
        var name: String? = null
        try {
            context.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) name = cursor.getString(0)
            }
        } catch (e: RuntimeException) {
            // geen naam bekend: de laatste stuk van het adres, of de standaardnaam
        }
        return AttachmentName.clean(name ?: uri.lastPathSegment)
    }

    /** Het bestand bij een token en nummer, of null als het niet bestaat of verlopen is. */
    fun open(context: Context, token: String, index: Int, now: Long = System.currentTimeMillis()): Item? {
        synchronized(entries) {
            expire(context, now)
            return entries[token]?.items?.getOrNull(index)
        }
    }

    private fun expire(context: Context, now: Long) {
        val it = entries.entries.iterator()
        while (it.hasNext()) {
            val (token, entry) = it.next()
            if (entry.expiresAt <= now) {
                File(root(context), token).deleteRecursively()
                it.remove()
            }
        }
    }

    /** Alles wissen (bij het opstarten). */
    fun clear(context: Context) {
        synchronized(entries) { entries.clear() }
        root(context).deleteRecursively()
    }
}
